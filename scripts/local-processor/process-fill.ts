import { readFile, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { ConvexClient, type Task } from "./convex-client.js";
import { extractJsonFromOutput, runClaude, cleanupNotebook } from "./utils.js";

export async function processFill(client: ConvexClient, task: Task): Promise<void> {
  console.log(`Processing form fill for ${task._id} (${task.name})`);

  await client.updateStatus(task._id, "filling_forms", "Локальное заполнение: подготовка...", 5);

  const data = await client.getProcurementData(task._id);
  const { procurement, calcData, forms } = data;

  if (!forms || forms.length === 0) {
    throw new Error("Нет извлечённых форм для заполнения");
  }

  // Load profiles
  let profiles: any;
  try {
    const profilesPath = new URL("./profiles.json", import.meta.url);
    profiles = JSON.parse(await readFile(profilesPath, "utf-8"));
  } catch {
    throw new Error("profiles.json not found. Run: npm run export-profiles");
  }

  const profile = profiles[procurement.profileId];
  if (!profile) throw new Error(`Profile ${procurement.profileId} not found`);

  // Calculate pricing
  const ourTotalPrice = calcData.reduce((sum: number, d: any) => sum + (d.ourTotal || 0), 0);
  const ndsRate = profile.tax?.ndsRate || 5;
  const ndsAmount = Math.round(ourTotalPrice * ndsRate / (100 + ndsRate) * 100) / 100;

  const tmpDir = await mkdtemp(join(tmpdir(), "tm-fill-"));
  try {
    for (const form of forms) {
      if (!form.url) continue;
      const filePath = join(tmpDir, form.fileName);
      await client.downloadFile(form.url, filePath);
    }

    const promptTemplate = await readFile(
      new URL("./prompts/form-filling.md", import.meta.url),
      "utf-8"
    );

    const contextData = {
      procurement: {
        number: procurement.number,
        name: procurement.name,
        nmck: procurement.nmck,
        deliveryDeadline: procurement.deliveryDeadline,
        deliveryAddresses: procurement.deliveryAddresses,
      },
      pricing: { ourTotalPrice, ndsRate, ndsAmount, ndsLabel: profile.tax?.ndsLabel || "НДС 5%" },
      profile,
      items: calcData.map((d: any) => ({
        name: d.itemName,
        quantity: d.quantity,
        ourUnitPrice: d.ourUnitPrice || 0,
        ourTotal: d.ourTotal || 0,
        ourSpecs: d.ourSpecs || "",
        tzSpecs: d.tzSpecs || "",
      })),
      forms: forms.map((f: any) => ({
        formId: f._id,
        name: f.name,
        fileName: f.fileName,
        fileType: f.fileType,
        localPath: join(tmpDir, f.fileName),
      })),
    };

    const prompt = `${promptTemplate}

## Context Data
\`\`\`json
${JSON.stringify(contextData, null, 2)}
\`\`\`

Read the form files from the local paths listed above, use NotebookLM to check procurement docs for any missing details, then generate fill instructions for each form.`;

    await client.updateStatus(task._id, "filling_forms", "Claude Code заполняет формы...", 30);

    const rawOutput = await runClaude(prompt);
    const fillResults = extractJsonFromOutput(rawOutput);

    // Cancellation check
    const currentData = await client.getProcurementData(task._id);
    if (currentData.procurement?.status !== "filling_forms") {
      console.log(`Task ${task._id} was cancelled, aborting`);
      return;
    }

    await client.updateStatus(task._id, "filling_forms", "Применение заполнения...", 80);

    const formattedResults = (Array.isArray(fillResults) ? fillResults : [fillResults]).map((r: any) => ({
      formId: r.formId,
      instructions: JSON.stringify(r.instructions),
    }));

    await client.saveFillResult(task._id, formattedResults);

    await client.updateStatus(task._id, "completed", "Формы заполнены (локально)", 100);

    try {
      await cleanupNotebook(`Закупка_${procurement.number || task._id}`);
    } catch (e) {
      console.warn(`Failed to cleanup notebook: ${e}`);
    }

    console.log(`Form fill complete for ${task._id}`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
