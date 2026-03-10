"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal, api } from "./_generated/api";
import Anthropic from "@anthropic-ai/sdk";
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

export const analyzeDocuments = action({
  args: { procurementId: v.id("procurements") },
  handler: async (ctx, args) => {
    await ctx.runMutation(api.procurements.updateStatus, {
      id: args.procurementId,
      status: "analyzing",
      statusMessage: "Парсинг файлов...",
    });

    try {
      const files = await ctx.runQuery(api.files.listByProcurement, {
        procurementId: args.procurementId,
      });

      if (files.length === 0) {
        throw new Error("Нет загруженных файлов");
      }

      const parsedFiles: Array<{ name: string; content: string }> = [];

      for (const file of files) {
        if (!file.url) continue;
        const response = await fetch(file.url);
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const content = await parseFile(buffer, file.fileType, file.fileName);
        parsedFiles.push({ name: file.fileName, content });
      }

      await ctx.runMutation(api.procurements.updateStatus, {
        id: args.procurementId,
        status: "analyzing",
        statusMessage: "Анализ ИИ...",
      });

      const anthropic = new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY,
      });

      const fileContents = parsedFiles
        .map((f) => `=== FILE: ${f.name} ===\n${f.content}`)
        .join("\n\n---\n\n");

      let retries = 0;
      let extractedData: any = null;

      while (retries < 3 && !extractedData) {
        try {
          const response = await anthropic.messages.create({
            model: "claude-sonnet-4-20250514",
            max_tokens: 8000,
            messages: [
              {
                role: "user",
                content: `${EXTRACTION_PROMPT}\n\nДокументы:\n\n${fileContents}`,
              },
            ],
          });

          const text = response.content
            .filter((b): b is Anthropic.TextBlock => b.type === "text")
            .map((b) => b.text)
            .join("");

          extractedData = JSON.parse(text);
        } catch (e) {
          retries++;
          if (retries >= 3)
            throw new Error(`AI extraction failed after 3 retries: ${e}`);
        }
      }

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
      for (const item of extractedData.items || []) {
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

      // Calculate logistics
      await ctx.runAction(api.logistics.calculateDelivery, {
        procurementId: args.procurementId,
      });

      await ctx.runMutation(api.procurements.updateStatus, {
        id: args.procurementId,
        status: "analyzed",
        statusMessage: `Извлечено ${(extractedData.items || []).length} позиций`,
      });
    } catch (error: any) {
      await ctx.runMutation(api.procurements.updateStatus, {
        id: args.procurementId,
        status: "error",
        statusMessage: `Ошибка анализа: ${error.message}`,
      });
    }
  },
});
