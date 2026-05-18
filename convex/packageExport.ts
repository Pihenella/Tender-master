"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { api } from "./_generated/api";
import { findOrCreateFolder, uploadOrReplaceFile } from "./googleDrive";

const ROOT_FORM_TYPES = new Set([
  "packageSummary",
  "packageInventory",
  "submissionMemo",
  "confidenceReport",
]);

const PACKAGE_FOLDERS = [
  "source_docs",
  "first_part",
  "second_part",
  "price_offer",
  "required_docs",
] as const;

type PackageFolder = (typeof PACKAGE_FOLDERS)[number] | "root";

type DriveExportResult = {
  folderId: string;
  folderUrl: string;
  uploadedCount: number;
  uploadedFiles: Array<{
    fileName: string;
    folder: PackageFolder;
    driveFileId: string;
  }>;
};

type ProcurementForDrive = {
  _id: string;
  number?: string;
  name?: string;
  driveFolderId?: string;
};

function safeDriveFolderName(value: string) {
  return value
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function procurementFolderName(procurement: {
  number?: string;
  name?: string;
  _id: string;
}) {
  const parts = [procurement.number, procurement.name]
    .map((part) => String(part || "").trim())
    .filter(Boolean);
  return safeDriveFolderName(parts.join(" - ")) || `Закупка ${procurement._id.slice(-6)}`;
}

function inferPackageSection(file: {
  packageSection?: string;
  formType: string;
  fileName: string;
}): PackageFolder {
  if (file.packageSection && ["root", ...PACKAGE_FOLDERS].includes(file.packageSection)) {
    return file.packageSection as PackageFolder;
  }

  const name = `${file.fileName} ${file.formType}`.toLowerCase();
  if (ROOT_FORM_TYPES.has(file.formType)) return "root";
  if (file.formType === "calculation" || name.includes("цен") || name.includes("калькуляц")) {
    return "price_offer";
  }
  if (name.includes("техническ") || name.includes("первая")) return "first_part";
  if (name.includes("выписк") || name.includes("лиценз") || name.includes("сертифик")) {
    return "required_docs";
  }
  return "second_part";
}

function mimeTypeForFile(fileName: string, fallback = "application/octet-stream") {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".docx")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (lower.endsWith(".xlsx")) {
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (lower.endsWith(".txt")) return "text/plain; charset=utf-8";
  return fallback;
}

async function downloadStorageFile(url: string | null, fileName: string) {
  if (!url) throw new Error(`Файл ${fileName} не найден в хранилище`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Не удалось скачать ${fileName} из хранилища`);
  }
  return Buffer.from(await res.arrayBuffer());
}

export const exportPackageToDrive = action({
  args: {
    procurementId: v.id("procurements"),
  },
  handler: async (ctx, args): Promise<DriveExportResult> => {
    const rootFolderId = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
    if (!rootFolderId) throw new Error("GOOGLE_DRIVE_ROOT_FOLDER_ID not set");

    const procurement = (await ctx.runQuery(api.procurements.get, {
      id: args.procurementId,
    })) as ProcurementForDrive | null;
    if (!procurement) throw new Error("Procurement not found");

    let folderId: string | undefined = procurement.driveFolderId;
    if (!folderId) {
      folderId = await findOrCreateFolder(
        procurementFolderName(procurement),
        rootFolderId
      );
      await ctx.runMutation(api.files.updateDriveFolderId, {
        procurementId: args.procurementId,
        driveFolderId: folderId,
      });
    }

    const sourceFiles = await ctx.runQuery(api.files.listByProcurement, {
      procurementId: args.procurementId,
    });
    const generatedFiles = await ctx.runQuery(api.files.getGeneratedFiles, {
      procurementId: args.procurementId,
    });

    const sectionFolderIds: Record<PackageFolder, string> = {
      root: folderId,
      source_docs: "",
      first_part: "",
      second_part: "",
      price_offer: "",
      required_docs: "",
    };

    for (const section of PACKAGE_FOLDERS) {
      sectionFolderIds[section] = await findOrCreateFolder(section, folderId);
    }

    const uploadedFiles: Array<{
      fileName: string;
      folder: PackageFolder;
      driveFileId: string;
    }> = [];

    for (const file of sourceFiles) {
      const buffer = await downloadStorageFile(file.url, file.fileName);
      const driveFileId = await uploadOrReplaceFile(
        file.fileName,
        buffer,
        file.fileType || mimeTypeForFile(file.fileName),
        sectionFolderIds.source_docs
      );
      uploadedFiles.push({
        fileName: file.fileName,
        folder: "source_docs",
        driveFileId,
      });
    }

    for (const file of generatedFiles) {
      const folder = inferPackageSection(file);
      const buffer = await downloadStorageFile(file.url, file.fileName);
      const driveFileId = await uploadOrReplaceFile(
        file.fileName,
        buffer,
        mimeTypeForFile(file.fileName),
        sectionFolderIds[folder]
      );
      uploadedFiles.push({
        fileName: file.fileName,
        folder,
        driveFileId,
      });
    }

    return {
      folderId,
      folderUrl: `https://drive.google.com/drive/folders/${folderId}`,
      uploadedCount: uploadedFiles.length,
      uploadedFiles,
    };
  },
});
