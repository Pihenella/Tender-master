// scripts/uploadTemplates.ts
// Usage: npx tsx scripts/uploadTemplates.ts
//
// Uploads template files from /home/Iurii/docs/ to Convex storage
// and saves metadata in formTemplates table.

import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import fs from "fs";

const CONVEX_URL =
  process.env.CONVEX_URL || "https://industrious-salmon-568.convex.cloud";

const TEMPLATES = [
  {
    name: "form3",
    path: "/home/Iurii/docs/форма 3.docx",
    fileName: "форма 3.docx",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  {
    name: "form6",
    path: "/home/Iurii/docs/форма 6.docx",
    fileName: "форма 6.docx",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  {
    name: "techProposal",
    path: "/home/Iurii/docs/Приложение №3.1 к части II ИК - Тех.предложение.xlsx",
    fileName: "Приложение 3.1 Тех.предложение.xlsx",
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  },
  {
    name: "priceProposal",
    path: "/home/Iurii/docs/Приложение №3.2 к части II ИК - Цен.предложение нац. режим ед.коэф. (1).xlsx",
    fileName: "Приложение 3.2 Цен.предложение.xlsx",
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  },
];

async function main() {
  const client = new ConvexHttpClient(CONVEX_URL);

  for (const t of TEMPLATES) {
    if (!fs.existsSync(t.path)) {
      console.error(`  ✗ File not found: ${t.path}`);
      continue;
    }

    console.log(`Uploading ${t.name}: ${t.fileName}`);
    const fileBuffer = fs.readFileSync(t.path);
    const blob = new Blob([fileBuffer], { type: t.mime });

    const uploadUrl: string = await client.mutation(
      api.files.generateUploadUrl,
      {}
    );
    const res = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": t.mime },
      body: blob,
    });
    const { storageId } = (await res.json()) as { storageId: string };

    await client.mutation(api.files.saveFormTemplate, {
      name: t.name,
      storageId: storageId as any,
      fileName: t.fileName,
    });
    console.log(`  ✓ ${t.name} uploaded (${storageId})`);
  }

  console.log("\nAll templates uploaded successfully!");
}

main().catch(console.error);
