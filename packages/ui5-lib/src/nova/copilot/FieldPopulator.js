sap.ui.define([
    "./Logger"
], function (Logger) {
    "use strict";

    function fieldIndex(oEntityMeta) {
        var mFields = {};
        ((oEntityMeta && oEntityMeta.properties) || []).forEach(function (oProp) {
            mFields[oProp.name] = oProp;
        });
        return mFields;
    }

    function describe(oRawProperty) {
        return {
            name: oRawProperty.name,
            type: oRawProperty.type,
            label: oRawProperty["com.sap.vocabularies.Common.v1.Label"]
                ? oRawProperty["com.sap.vocabularies.Common.v1.Label"].String
                : (oRawProperty["sap:label"] || oRawProperty.name),
            maxLength: oRawProperty.maxLength,
            creatable: oRawProperty["sap:creatable"] !== "false",
            updatable: oRawProperty["sap:updatable"] !== "false",
            required: oRawProperty.nullable === "false"
        };
    }

    /**
     * Resolves a field that may sit behind navigation properties, such as
     * "Supplier/CompanyName", by walking the associations in the metamodel.
     * Returns the property description plus the entity it really belongs to.
     */
    function resolvePath(oMetaModel, sEntitySet, sPath) {
        if (!oMetaModel || !sEntitySet) {
            return null;
        }
        try {
            var oEntitySet = oMetaModel.getODataEntitySet(sEntitySet);
            var oEntityType = oEntitySet && oMetaModel.getODataEntityType(oEntitySet.entityType);
            if (!oEntityType) {
                return null;
            }

            var aParts = String(sPath).split("/");
            var sOwner = sEntitySet;

            for (var i = 0; i < aParts.length - 1; i++) {
                var oEnd = oMetaModel.getODataAssociationEnd(oEntityType, aParts[i]);
                if (!oEnd) {
                    return null;
                }
                oEntityType = oMetaModel.getODataEntityType(oEnd.type);
                if (!oEntityType) {
                    return null;
                }
                sOwner = aParts[i];
            }

            var sLeaf = aParts[aParts.length - 1];
            var oRaw = (oEntityType.property || []).filter(function (oProp) {
                return oProp.name === sLeaf;
            })[0];

            return oRaw
                ? { property: describe(oRaw), owner: sOwner, viaNavigation: aParts.length > 1 }
                : null;
        } catch (oError) {
            return null;
        }
    }

    /**
     * Turns the model's text value into the type the service declares, so the
     * form receives a number where it expects a number.
     * Returns { ok, value, reason }.
     */
    function coerce(oProperty, vValue) {
        var sType = (oProperty && oProperty.type) || "";

        if (vValue === null || vValue === undefined || vValue === "") {
            return { ok: true, value: null };
        }

        if (/Edm\.(Int16|Int32|Int64|Byte|SByte)/.test(sType)) {
            var iParsed = parseInt(vValue, 10);
            return isNaN(iParsed)
                ? { ok: false, reason: "'" + vValue + "' is not a whole number" }
                : { ok: true, value: iParsed };
        }

        if (/Edm\.(Decimal|Double|Single)/.test(sType)) {
            var fParsed = parseFloat(vValue);
            return isNaN(fParsed)
                ? { ok: false, reason: "'" + vValue + "' is not a number" }
                : { ok: true, value: /Edm\.Decimal/.test(sType) ? String(fParsed) : fParsed };
        }

        if (sType === "Edm.Boolean") {
            var sNormalised = String(vValue).trim().toLowerCase();
            if (["true", "yes", "x", "1"].indexOf(sNormalised) !== -1) {
                return { ok: true, value: true };
            }
            if (["false", "no", "", "0"].indexOf(sNormalised) !== -1) {
                return { ok: true, value: false };
            }
            return { ok: false, reason: "'" + vValue + "' is not yes or no" };
        }

        if (/Edm\.(DateTime|DateTimeOffset)/.test(sType)) {
            var oDate = new Date(vValue);
            return isNaN(oDate.getTime())
                ? { ok: false, reason: "'" + vValue + "' is not a date" }
                : { ok: true, value: oDate };
        }

        var sText = String(vValue);
        var iMax = parseInt(oProperty && oProperty.maxLength, 10);
        if (iMax && sText.length > iMax) {
            return { ok: false, reason: "longer than the " + iMax + " characters allowed" };
        }
        return { ok: true, value: sText };
    }

    return {
        /**
         * Reads an entity type's real metamodel properties (name, type,
         * label, maxLength, creatable, updatable) plus its key field names -
         * exposed so other features (e.g. the bulk Excel upload template)
         * can work out which fields are actually safe to offer for create,
         * the same way this module already does for a single record, rather
         * than relying on ContextCollector's thinner {name,type,label}
         * shape (built for the LLM prompt, not for this).
         * @returns {{properties: object[], keyFields: string[]}|null}
         */
        describeEntityType: function (oODataModel, sEntitySet) {
            var oMetaModel = oODataModel && oODataModel.getMetaModel && oODataModel.getMetaModel();
            if (!oMetaModel || !sEntitySet) {
                return null;
            }
            try {
                var oEntitySet = oMetaModel.getODataEntitySet(sEntitySet);
                var oEntityType = oEntitySet && oMetaModel.getODataEntityType(oEntitySet.entityType);
                if (!oEntityType) {
                    return null;
                }
                var aKeyFields = ((oEntityType.key && oEntityType.key.propertyRef) || [])
                    .map(function (oRef) { return oRef.name; });
                var aProperties = (oEntityType.property || []).map(describe);
                return { properties: aProperties, keyFields: aKeyFields };
            } catch (oError) {
                return null;
            }
        },

        /**
         * Turns raw text into the type a given OData property declares -
         * exposed so other features (e.g. bulk Excel upload) can validate/
         * coerce a cell value exactly the way a single-record fill already
         * does, instead of re-implementing type coercion a second time.
         * Returns { ok, value, reason }.
         */
        coerce: coerce,

        /**
         * Writes values into the record currently open for editing. This only
         * fills the form - nothing is submitted. The user still reviews the
         * fields and presses Save, so the assistant can never persist anything.
         *
         * @param {object[]} aValues [{ field, value }] as described by the model
         * @param {object} mParams
         * @param {sap.ui.model.odata.v2.ODataModel} mParams.model
         * @param {sap.ui.model.Context} mParams.context the bound record
         * @param {object} mParams.entityMeta for validating names and types
         * @param {boolean} mParams.createMode
         * @returns {{applied: object[], skipped: object[]}}
         */
        run: function (aValues, mParams) {
            var mFields = fieldIndex(mParams.entityMeta);
            var aApplied = [];
            var aSkipped = [];

            var oMetaModel = mParams.model && mParams.model.getMetaModel
                ? mParams.model.getMetaModel()
                : null;
            var aViaNavigation = [];

            (aValues || []).forEach(function (oValue) {
                var sField = oValue && oValue.field;
                var oProperty = mFields[sField];
                var bViaNavigation = false;

                // fields reached through an association, e.g. "Supplier/Phone"
                if (!oProperty) {
                    var oResolved = resolvePath(oMetaModel, mParams.entitySet, sField);
                    if (oResolved) {
                        oProperty = oResolved.property;
                        bViaNavigation = oResolved.viaNavigation;
                        if (bViaNavigation) {
                            aViaNavigation.push(sField);
                        }
                    }
                }

                if (!oProperty) {
                    aSkipped.push({ field: sField, reason: "no such field" });
                    Logger.warn("FieldPopulator", "skipped unknown field '" + sField + "'");
                    return;
                }

                // respect what the service says may be written
                var bWritable = mParams.createMode ? oProperty.creatable !== false
                    : oProperty.updatable !== false;
                if (!bWritable) {
                    aSkipped.push({
                        field: sField,
                        reason: mParams.createMode ? "not creatable" : "not editable"
                    });
                    Logger.warn("FieldPopulator", "'" + sField + "' is read-only here");
                    return;
                }

                var oCoerced = coerce(oProperty, oValue.value);
                if (!oCoerced.ok) {
                    aSkipped.push({ field: sField, reason: oCoerced.reason });
                    Logger.warn("FieldPopulator", "'" + sField + "': " + oCoerced.reason);
                    return;
                }

                try {
                    // writes into the pending record only - no request is sent
                    mParams.model.setProperty(sField, oCoerced.value, mParams.context);
                    aApplied.push({ field: sField, value: oCoerced.value, label: oProperty.label });
                    Logger.step("FieldPopulator", "set " + sField + " = " + oCoerced.value);
                } catch (oError) {
                    aSkipped.push({ field: sField, reason: oError.message });
                    Logger.error("FieldPopulator", "could not set '" + sField + "'", oError.message);
                }
            });

            Logger.step("FieldPopulator", "populated " + aApplied.length + " field(s), skipped " +
                aSkipped.length + " - nothing submitted");

            if (aViaNavigation.length) {
                Logger.warn("FieldPopulator", "these fields belong to a related entity, " +
                    "so saving will change that record for every item linked to it",
                    aViaNavigation);
            }

            return { applied: aApplied, skipped: aSkipped, viaNavigation: aViaNavigation };
        }
    };
});
