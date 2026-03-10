"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { api, internal } from "./_generated/api";
import Anthropic from "@anthropic-ai/sdk";

async function estimateDeliveryWithAI(
  destination: string,
  items: Array<{ name: string; weight: number; quantity: number }>
): Promise<number> {
  const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  const totalWeight = items.reduce((sum, i) => sum + i.weight * i.quantity, 0);

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 200,
    messages: [
      {
        role: "user",
        content: `Оцени примерную стоимость доставки груза транспортной компанией ПЭК.
Откуда: Екатеринбург
Куда: ${destination}
Общий вес: ${totalWeight} кг
Товары: ${items.map((i) => `${i.name} (${i.quantity} шт, ~${i.weight} кг/шт)`).join(", ")}

Ответь ТОЛЬКО числом в рублях, без пояснений. Например: 5500`,
      },
    ],
  });

  const text = (response.content[0] as Anthropic.TextBlock).text.trim();
  const cost = parseInt(text.replace(/\D/g, ""), 10);
  return isNaN(cost) ? 3000 : cost;
}

export const calculateDelivery = action({
  args: { procurementId: v.id("procurements") },
  handler: async (ctx, args) => {
    const procurement = await ctx.runQuery(api.procurements.get, {
      id: args.procurementId,
    });
    if (!procurement) throw new Error("Procurement not found");

    const items = await ctx.runQuery(api.files.getExtractedItems, {
      procurementId: args.procurementId,
    });

    if (items.length === 0) return;

    // Group items by delivery address
    const addressGroups = new Map<
      string,
      Array<{ _id: any; name: string; estimatedWeight: number; quantity: number }>
    >();

    for (const item of items) {
      if (item.deliveryAllocations.length > 0) {
        for (const alloc of item.deliveryAllocations) {
          const group = addressGroups.get(alloc.address) || [];
          group.push(item);
          addressGroups.set(alloc.address, group);
        }
      } else {
        // Default to first delivery address
        const addr =
          procurement.deliveryAddresses[0]?.address || "Челябинская область";
        const group = addressGroups.get(addr) || [];
        group.push(item);
        addressGroups.set(addr, group);
      }
    }

    // Try PEK public API, fallback to AI estimate
    for (const [address, groupItems] of addressGroups) {
      const totalWeight = groupItems.reduce(
        (s, i) => s + i.estimatedWeight * i.quantity,
        0
      );
      const volumeM3 = totalWeight * 0.004;

      let cost: number;
      let estimated = true;

      // Try PEK API
      try {
        const pekResponse = await fetch(
          "https://pecom.ru/ru/calc/through.php",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              senderCityId: 53, // Екатеринбург
              receiverCityId: address,
              goods: [
                {
                  width: 0.5,
                  height: 0.5,
                  length: 0.5,
                  volume: volumeM3,
                  weight: totalWeight,
                  isOversize: false,
                },
              ],
            }),
          }
        );

        if (pekResponse.ok) {
          const data = await pekResponse.json();
          if (data.transfer?.auto) {
            cost = Math.ceil(data.transfer.auto);
            estimated = false;
          } else {
            throw new Error("No PEK result");
          }
        } else {
          throw new Error("PEK API error");
        }
      } catch {
        // Fallback to AI estimate
        cost = await estimateDeliveryWithAI(
          address,
          groupItems.map((i) => ({
            name: i.name,
            weight: i.estimatedWeight,
            quantity: i.quantity,
          }))
        );
        estimated = true;
      }

      // Split cost proportionally by weight
      for (const item of groupItems) {
        const itemWeight = item.estimatedWeight * item.quantity;
        const proportion =
          totalWeight > 0 ? itemWeight / totalWeight : 1 / groupItems.length;
        const itemCost = Math.ceil(cost * proportion);

        await ctx.runMutation(internal.analysisHelpers.updateItemDelivery, {
          id: item._id,
          deliveryCost: itemCost,
          deliveryCostEstimated: estimated,
        });
      }
    }
  },
});
