import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { api, internal } from "./_generated/api";

const http = httpRouter();

function checkAuth(request: Request): boolean {
  const secret = process.env.CONVEX_LOCAL_PROCESSOR_SECRET;
  if (!secret) return false;
  const auth = request.headers.get("Authorization");
  return auth === `Bearer ${secret}`;
}

http.route({
  path: "/api/local/pending-tasks",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    if (!checkAuth(request)) {
      return new Response("Unauthorized", { status: 401 });
    }
    const tasks = await ctx.runQuery(api.procurements.getPendingLocalTasks, {});
    return Response.json(tasks);
  }),
});

http.route({
  path: "/api/local/update-status",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!checkAuth(request)) {
      return new Response("Unauthorized", { status: 401 });
    }
    const body = await request.json();
    await ctx.runMutation(api.procurements.updateStatus, {
      id: body.id,
      status: body.status,
      statusMessage: body.statusMessage,
      progress: body.progress,
    });
    return Response.json({ ok: true });
  }),
});

http.route({
  path: "/api/local/save-analysis",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!checkAuth(request)) {
      return new Response("Unauthorized", { status: 401 });
    }
    const body = await request.json();

    await ctx.runMutation(api.procurements.updateFromAnalysis, {
      id: body.procurementId,
      number: body.procurementNumber || "",
      name: body.procurementName || "Без названия",
      nmck: Number(body.nmck) || 0,
      deliveryDeadline: body.deliveryDeadline || "",
      deliveryAddresses: body.deliveryAddresses || [],
    });

    await ctx.runMutation(internal.analysisHelpers.clearProcurementData, {
      procurementId: body.procurementId,
    });

    for (const item of body.items || []) {
      await ctx.runMutation(internal.analysisHelpers.saveExtractedItem, {
        procurementId: body.procurementId,
        name: String(item.name || ""),
        quantity: Number(item.quantity) || 0,
        unit: String(item.unit || "шт"),
        nmckPrice: Number(item.nmckPrice) || 0,
        tzSpecs: String(item.tzSpecs || ""),
        quarter: String(item.quarter || ""),
        estimatedWeight: Number(item.estimatedWeight) || 0,
        estimatedDimensions: String(item.estimatedDimensions || ""),
        deliveryAllocations: (item.deliveryAllocations || []).map((a: any) => ({
          address: String(a.address || ""),
          quantity: Number(a.quantity) || 0,
        })),
        deliveryCost: 0,
        deliveryCostEstimated: false,
      });
    }

    for (let i = 0; i < (body.calcRows || []).length; i++) {
      const row = body.calcRows[i];
      await ctx.runMutation(internal.analysisHelpers.saveCalculationItem, {
        procurementId: body.procurementId,
        itemIndex: i,
        itemName: String(row.itemName || ""),
        pp1875: row.pp1875 || undefined,
        quantity: Number(row.quantity) || 0,
        nmckPrice: Number(row.nmckPrice) || 0,
        tzSpecs: row.tzSpecs || undefined,
      });
    }

    return Response.json({ ok: true });
  }),
});

http.route({
  path: "/api/local/trigger-slice",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!checkAuth(request)) {
      return new Response("Unauthorized", { status: 401 });
    }
    const body = await request.json();
    await ctx.runAction(internal.analysisActions.sliceForms, {
      procurementId: body.procurementId,
      forms: body.forms,
    });
    return Response.json({ ok: true });
  }),
});

http.route({
  path: "/api/local/trigger-calc",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!checkAuth(request)) {
      return new Response("Unauthorized", { status: 401 });
    }
    const body = await request.json();
    await ctx.runAction(internal.analysisActions.generateCalcExcel, {
      procurementId: body.procurementId,
    });
    return Response.json({ ok: true });
  }),
});

http.route({
  path: "/api/local/save-fill",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!checkAuth(request)) {
      return new Response("Unauthorized", { status: 401 });
    }
    const body = await request.json();
    await ctx.runAction(internal.formFillingActions.applyFillInstructions, {
      procurementId: body.procurementId,
      fillResults: body.fillResults,
    });
    return Response.json({ ok: true });
  }),
});

http.route({
  path: "/api/local/get-procurement",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!checkAuth(request)) {
      return new Response("Unauthorized", { status: 401 });
    }
    const body = await request.json();
    const procurement = await ctx.runQuery(api.procurements.get, { id: body.id });
    const files = await ctx.runQuery(api.files.listByProcurement, {
      procurementId: body.id,
    });
    const calcData = await ctx.runQuery(api.files.getCalculationData, {
      procurementId: body.id,
    });
    const forms = await ctx.runQuery(api.files.getExtractedForms, {
      procurementId: body.id,
    });
    return Response.json({ procurement, files, calcData, forms });
  }),
});

export default http;
