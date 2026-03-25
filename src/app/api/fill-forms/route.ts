import { processFormFilling } from "@/lib/server/processor";

export async function POST(req: Request) {
  const { procurementId, profileId, formIds } = await req.json();
  if (!procurementId) return Response.json({ error: "procurementId required" }, { status: 400 });

  processFormFilling(procurementId, { profileId, formIds }).catch((e) =>
    console.error("Form filling failed:", e)
  );

  return Response.json({ started: true });
}
