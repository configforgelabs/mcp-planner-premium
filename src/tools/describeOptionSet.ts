import { z } from "zod";
import { getApiBase } from "../config.js";
import { dvReq, dvHeaders } from "../dataverse.js";
import type { ToolDef } from "./types.js";

// Reads option-set (choice) metadata so the model never guesses magic numbers.
// Tries Picklist, then Status, then State attribute-metadata casts (environments
// differ on how msdyn_status is modelled).
const CASTS = [
  "Microsoft.Dynamics.CRM.PicklistAttributeMetadata",
  "Microsoft.Dynamics.CRM.StatusAttributeMetadata",
  "Microsoft.Dynamics.CRM.StateAttributeMetadata",
];

export const describeOptionSet: ToolDef = {
  name: "describe_option_set",
  title: "Describe Option Set (choice values)",
  description:
    "Returns the option-set (choice) values + labels for a Dataverse column, so you use the right numeric values instead of guessing. Examples: entity 'msdyn_projecttaskdependency' attribute 'msdyn_projecttaskdependencylinktype' (FS/SS/FF/SF link types); entity 'msdyn_operationset' attribute 'msdyn_status' (change-session status). Read-only metadata.",
  inputSchema: {
    entityLogicalName: z
      .string()
      .describe("Entity logical name, e.g. msdyn_projecttaskdependency."),
    attributeLogicalName: z
      .string()
      .describe("Attribute (column) logical name, e.g. msdyn_projecttaskdependencylinktype."),
  },
  handler: async (input: { entityLogicalName: string; attributeLogicalName: string }) => {
    const BASE = getApiBase();
    const entity = (input.entityLogicalName || "").trim();
    const attribute = (input.attributeLogicalName || "").trim();
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(entity))
      throw new Error("entityLogicalName must be a logical name (letters, digits, underscore).");
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(attribute))
      throw new Error("attributeLogicalName must be a logical name.");

    let lastStatus = 0;
    for (const cast of CASTS) {
      const url =
        BASE +
        "/EntityDefinitions(LogicalName='" +
        entity +
        "')/Attributes(LogicalName='" +
        attribute +
        "')/" +
        cast +
        "?$select=LogicalName&$expand=OptionSet($select=Options)";
      const res = await dvReq({ url, method: "GET", headers: dvHeaders() }, { retry: true });
      if (res.status >= 400) {
        lastStatus = res.status;
        continue;
      }
      const options = (res.json?.OptionSet?.Options || []).map((o: any) => ({
        value: o.Value,
        label: o.Label?.UserLocalizedLabel?.Label ?? null,
      }));
      return {
        ok: true,
        entity,
        attribute,
        metadataType: cast.split(".").pop(),
        options,
      };
    }
    throw new Error(
      "describe_option_set: could not read option metadata for " +
        entity +
        "." +
        attribute +
        " (last HTTP " +
        lastStatus +
        "). Check the entity/attribute logical names.",
    );
  },
};
