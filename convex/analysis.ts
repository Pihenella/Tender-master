"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal, api } from "./_generated/api";
import { parseFile } from "../src/lib/parsers";

const EXTRACTION_PROMPT = `You are analyzing Russian procurement (закупка) documentation files.
Extract the following structured data as JSON:

{
  "procurementNumber": "string - номер закупки",
  "procurementName": "string - название закупки",
  "nmck": number - общая НМЦК (начальная максимальная цена контракта) в рублях,
  "deliveryDeadline": "string - срок поставки",
  "deliveryAddresses": [{"name": "string - название грузополучателя", "address": "string - адрес"}],
  "items": [
    {
      "name": "string - наименование товара",
      "quantity": number,
      "unit": "string - единица измерения",
      "nmckPrice": number - НМЦК за единицу,
      "tzSpecs": "string - технические характеристики из ТЗ",
      "quarter": "string - квартал поставки",
      "estimatedWeight": number - примерный вес в кг (оцени по наименованию),
      "estimatedDimensions": "string - примерные габариты ДxШxВ см",
      "deliveryAllocations": [{"address": "string", "quantity": number}]
    }
  ]
}

IMPORTANT:
- Extract ALL items from the product list/ТЗ
- For estimatedWeight: estimate based on typical weight of the product by its name
- For deliveryAllocations: if items go to multiple addresses, split quantities accordingly
- All prices in rubles, no formatting
- Return ONLY valid JSON, no markdown or comments`;

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

async function callGemini(apiKey: string, prompt: string, maxRetries = 3): Promise<string> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: 65536,
          temperature: 0.1,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    });

    if (res.status === 429) {
      const waitMs = 60000 * (attempt + 1);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini API ${res.status}: ${errText}`);
    }

    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts
      ?.map((p: any) => p.text)
      .join("") || "";

    if (!text) throw new Error("Empty response from Gemini");
    return text;
  }
  throw new Error("Gemini API: max retries exceeded");
}

export const analyzeDocuments = action({
  args: { procurementId: v.id("procurements") },
  handler: async (ctx, args) => {
    const updateProgress = async (msg: string, progress: number) => {
      await ctx.runMutation(api.procurements.updateStatus, {
        id: args.procurementId,
        status: "analyzing",
        statusMessage: msg,
        progress,
      });
    };

    try {
      // Step 1: Load files (0-20%)
      await updateProgress("Загрузка файлов...", 0);

      const files = await ctx.runQuery(api.files.listByProcurement, {
        procurementId: args.procurementId,
      });

      if (files.length === 0) {
        throw new Error("Нет загруженных файлов");
      }

      const parsedFiles: Array<{ name: string; content: string }> = [];

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (!file.url) continue;
        await updateProgress(
          `Парсинг файла ${i + 1}/${files.length}: ${file.fileName}`,
          Math.round((i / files.length) * 20)
        );
        const response = await fetch(file.url);
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const content = await parseFile(buffer, file.fileType, file.fileName);
        parsedFiles.push({ name: file.fileName, content });
      }

      // Step 2: AI Analysis (20-80%)
      await updateProgress(`Отправка ${parsedFiles.length} файлов в ИИ...`, 20);

      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error("GEMINI_API_KEY is not set");
      }

      // Limit total size to ~500K chars (~125K tokens) to avoid Gemini timeouts
      const MAX_CHARS = 500000;
      const priorityKeywords = ["ТЗ", "техническ", "извещение", "документация", "НМЦ", "расчет", "приложение"];
      const sortedFiles = [...parsedFiles].sort((a, b) => {
        const aP = priorityKeywords.some(k => a.name.toLowerCase().includes(k.toLowerCase())) ? 0 : 1;
        const bP = priorityKeywords.some(k => b.name.toLowerCase().includes(k.toLowerCase())) ? 0 : 1;
        return aP - bP;
      });

      let totalChars = 0;
      const includedFiles: typeof parsedFiles = [];
      for (const f of sortedFiles) {
        if (totalChars + f.content.length > MAX_CHARS && includedFiles.length > 0) {
          // Truncate last file if it partially fits
          const remaining = MAX_CHARS - totalChars;
          if (remaining > 10000) {
            includedFiles.push({ name: f.name, content: f.content.slice(0, remaining) + "\n...[ОБРЕЗАНО]" });
          }
          break;
        }
        includedFiles.push(f);
        totalChars += f.content.length;
      }

      const fileContents = includedFiles
        .map((f) => `=== FILE: ${f.name} ===\n${f.content}`)
        .join("\n\n---\n\n");

      const fullPrompt = `${EXTRACTION_PROMPT}\n\nДокументы:\n\n${fileContents}`;

      await updateProgress("ИИ анализирует документы...", 30);

      const result = await callGemini(apiKey, fullPrompt);

      await updateProgress("Обработка ответа ИИ...", 70);

      let extractedData: any;
      try {
        extractedData = JSON.parse(result);
      } catch {
        const jsonMatch = result.match(/```json\s*([\s\S]*?)\s*```/) || result.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          extractedData = JSON.parse(jsonMatch[1] || jsonMatch[0]);
        } else {
          throw new Error("Failed to parse AI response as JSON");
        }
      }

      // Step 3: Save results (80-100%)
      await updateProgress("Сохранение метаданных закупки...", 80);

      await ctx.runMutation(api.procurements.updateFromAnalysis, {
        id: args.procurementId,
        number: extractedData.procurementNumber || "",
        name: extractedData.procurementName || "Без названия",
        nmck: Number(extractedData.nmck) || 0,
        deliveryDeadline: extractedData.deliveryDeadline || "",
        deliveryAddresses: extractedData.deliveryAddresses || [],
      });

      // Clear previous items
      const oldItems = await ctx.runQuery(api.files.getExtractedItems, {
        procurementId: args.procurementId,
      });
      for (const item of oldItems) {
        await ctx.runMutation(internal.analysisHelpers.deleteExtractedItem, {
          id: item._id,
        });
      }

      // Save new items
      const items = extractedData.items || [];
      for (let i = 0; i < items.length; i++) {
        if (i % 20 === 0) {
          await updateProgress(
            `Сохранение позиций: ${i}/${items.length}`,
            80 + Math.round((i / items.length) * 18)
          );
        }
        const item = items[i];
        await ctx.runMutation(internal.analysisHelpers.saveExtractedItem, {
          procurementId: args.procurementId,
          name: String(item.name || ""),
          quantity: Number(item.quantity) || 0,
          unit: String(item.unit || "шт"),
          nmckPrice: Number(item.nmckPrice) || 0,
          tzSpecs: String(item.tzSpecs || ""),
          quarter: String(item.quarter || ""),
          estimatedWeight: Number(item.estimatedWeight) || 0,
          estimatedDimensions: String(item.estimatedDimensions || ""),
          deliveryAllocations: (item.deliveryAllocations || []).map(
            (a: any) => ({
              address: String(a.address || ""),
              quantity: Number(a.quantity) || 0,
            })
          ),
          deliveryCost: 0,
          deliveryCostEstimated: false,
        });
      }

      await ctx.runMutation(api.procurements.updateStatus, {
        id: args.procurementId,
        status: "analyzed",
        statusMessage: `Извлечено ${items.length} позиций`,
        progress: 100,
      });
    } catch (error: any) {
      await ctx.runMutation(api.procurements.updateStatus, {
        id: args.procurementId,
        status: "error",
        statusMessage: `Ошибка анализа: ${error.message}`,
        progress: 0,
      });
    }
  },
});
