"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { api } from "./_generated/api";

function isCollectiveParticipantForm(formName: string) {
  const normalized = formName
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ")
    .trim();

  return normalized.includes("коллективн");
}

function normalize(value: string) {
  return value.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}

function isRequiredByPackagePlan(formName: string, plan: {
  applicationRequirements: Array<{
    section: string;
    obligation: string;
    status: string;
    requiredDocumentName: string;
    requirementText: string;
  }>;
} | null) {
  if (!plan || plan.applicationRequirements.length === 0) return true;
  const normalizedName = normalize(formName);
  return plan.applicationRequirements.some((requirement) => {
    if (requirement.obligation === "not_applicable" || requirement.status === "not_applicable") return false;
    if (requirement.section === "required_docs" || requirement.section === "platform_actions") return false;
    const documentName = normalize(requirement.requiredDocumentName);
    const target = normalize(`${requirement.requiredDocumentName} ${requirement.requirementText}`);
    return target.includes(normalizedName) || (documentName.length > 0 && normalizedName.includes(documentName));
  });
}

export const fillForms = action({
  args: {
    procurementId: v.id("procurements"),
    profileId: v.optional(v.string()),
    formIds: v.optional(v.array(v.string())),
    fillEngine: v.optional(v.union(v.literal("v1"), v.literal("v2"))),
  },
  handler: async (ctx, args) => {
    const extractedForms = await ctx.runQuery(api.files.getExtractedForms, {
      procurementId: args.procurementId,
    });

    if (extractedForms.length === 0) {
      await ctx.runMutation(api.procurements.updateStatus, {
        id: args.procurementId,
        status: "calculation_uploaded",
        statusMessage: "Нет извлечённых форм для заполнения",
        progress: 0,
      });
      return;
    }

    const fillableForms = extractedForms.filter((form) => !isCollectiveParticipantForm(form.name));
    const skippedCount = extractedForms.length - fillableForms.length;
    const packagePlan = await ctx.runQuery(api.procurements.getBidPackagePlan, {
      procurementId: args.procurementId,
    });
    const packageRequiredForms = fillableForms.filter((form) => isRequiredByPackagePlan(form.name, packagePlan));
    const skippedByPlan = fillableForms.length - packageRequiredForms.length;

    if (fillableForms.length === 0) {
      await ctx.runMutation(api.procurements.updateStatus, {
        id: args.procurementId,
        status: "calculation_uploaded",
        statusMessage: "Нет форм для заполнения: формы коллективного участника пропущены",
        progress: 0,
      });
      return;
    }

    let fillFormIds: string[] = packageRequiredForms.map((form) => String(form._id));
    if (args.formIds) {
      const uniqueFormIds = Array.from(new Set(args.formIds));
      if (uniqueFormIds.length === 0) {
        await ctx.runMutation(api.procurements.updateStatus, {
          id: args.procurementId,
          status: "calculation_uploaded",
          statusMessage: "Не выбрано ни одной формы для заполнения",
          progress: 0,
        });
        return;
      }

      const knownFormIds = new Set(fillableForms.map((form) => String(form._id)));
      fillFormIds = uniqueFormIds.filter((formId) => knownFormIds.has(formId));

      if (fillFormIds.length === 0) {
        await ctx.runMutation(api.procurements.updateStatus, {
          id: args.procurementId,
          status: "calculation_uploaded",
          statusMessage: "Выбранные формы не заполняются: формы коллективного участника пропущены",
          progress: 0,
        });
        return;
      }
    }

    if (fillFormIds.length === 0) {
      await ctx.runMutation(api.procurements.updateStatus, {
        id: args.procurementId,
        status: "calculation_uploaded",
        statusMessage: "Нет форм для заполнения по плану заявки",
        progress: 0,
      });
      return;
    }

    // Store params for local processor to pick up
    await ctx.runMutation(api.procurements.setFillParams, {
      id: args.procurementId,
      fillProfileId: args.profileId,
      fillFormIds: fillFormIds,
      fillEngine: args.fillEngine,
    });

    await ctx.runMutation(api.procurements.updateStatus, {
      id: args.procurementId,
      status: "filling_forms",
      statusMessage: `Ожидание обработчика: выбрано ${fillFormIds.length} из ${extractedForms.length} форм${
        skippedCount > 0 ? `, коллективные пропущены: ${skippedCount}` : ""
      }${skippedByPlan > 0 && !args.formIds ? `, не по плану заявки: ${skippedByPlan}` : ""}`,
      progress: 0,
    });
  },
});
