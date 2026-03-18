import { readFile, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { ConvexClient, type Task } from "./convex-client.js";
import { extractJsonFromOutput, runClaude, cleanupNotebook } from "./utils.js";

export async function processAnalysis(client: ConvexClient, task: Task): Promise<void> {
  const notebookName = `Закупка_${task.number || task._id}`;
  console.log(`Processing analysis for ${task._id} (${task.name})`);

  await client.updateStatus(task._id, "analyzing", "Локальный анализ: загрузка файлов...", 5);

  const data = await client.getProcurementData(task._id);
  const files = data.files;
  if (!files.length) throw new Error("Нет загруженных файлов");

  const tmpDir = await mkdtemp(join(tmpdir(), "tm-analysis-"));
  try {
    await client.updateStatus(task._id, "analyzing", "Локальный анализ: скачивание файлов...", 10);

    const fileList: string[] = [];
    for (const file of files) {
      if (!file.url) continue;
      const filePath = join(tmpDir, file.fileName);
      await client.downloadFile(file.url, filePath);
      fileList.push(filePath);
    }

    const promptTemplate = await readFile(
      new URL("./prompts/extraction.md", import.meta.url),
      "utf-8"
    );

    const prompt = `${promptTemplate}

## Procurement ID: ${task._id}
## Procurement Name: ${task.name || "Новая закупка"}

## Files to analyze (downloaded to local filesystem):
${fileList.map(f => `- ${f}`).join("\n")}

Read these files from the local filesystem, upload their contents to a NotebookLM notebook named "${notebookName}", then perform the RAG queries described above.

Return the structured JSON result.`;

    await client.updateStatus(task._id, "analyzing", "Локальный анализ: Claude Code обрабатывает...", 20);

    const rawOutput = await runClaude(prompt);
    const result = extractJsonFromOutput(rawOutput);

    // Cancellation check
    const currentData = await client.getProcurementData(task._id);
    if (currentData.procurement?.status !== "analyzing") {
      console.log(`Task ${task._id} was cancelled, aborting`);
      return;
    }

    await client.updateStatus(task._id, "analyzing", "Сохранение результатов...", 70);
    await client.saveAnalysisResult(task._id, {
      procurementNumber: result.procurementNumber,
      procurementName: result.procurementName,
      nmck: result.nmck,
      deliveryDeadline: result.deliveryDeadline,
      deliveryAddresses: result.deliveryAddresses,
      items: result.items,
      calcRows: result.calcRows || result.items,
    });

    await client.updateStatus(task._id, "analyzing", "Нарезка форм...", 80);
    if (result.forms && result.forms.length > 0) {
      await client.triggerSlice(task._id, result.forms);
    }

    await client.updateStatus(task._id, "analyzing", "Генерация калькуляции...", 90);
    await client.triggerCalc(task._id);

    await client.updateStatus(
      task._id,
      "analyzed",
      `Извлечено ${(result.items || []).length} позиций, ${(result.forms || []).length} форм (локально)`,
      100
    );

    try {
      await cleanupNotebook(notebookName);
      console.log(`Cleaned up notebook "${notebookName}"`);
    } catch (e) {
      console.warn(`Failed to cleanup notebook: ${e}`);
    }

    console.log(`Analysis complete for ${task._id}`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
