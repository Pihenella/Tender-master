import { processAnalysis } from "@/lib/server/processor";

export async function POST(req: Request) {
  const { procurementId } = await req.json();
  if (!procurementId) return Response.json({ error: "procurementId required" }, { status: 400 });

  // Fire and forget — processing runs in background
  processAnalysis(procurementId).catch((e) => console.error("Analysis failed:", e));

  return Response.json({ started: true });
}
