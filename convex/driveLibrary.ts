"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { listFiles } from "./googleDrive";

const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const DEFAULT_MAX_DEPTH = 4;
const MAX_ITEMS = 500;

type DriveLibraryEntry = {
  id: string;
  name: string;
  mimeType: string;
  path: string;
  isFolder: boolean;
  depth: number;
};

async function listTree(
  folderId: string,
  folderPath: string,
  depth: number,
  maxDepth: number,
  entries: DriveLibraryEntry[]
) {
  if (depth > maxDepth || entries.length >= MAX_ITEMS) return;

  const files = await listFiles(folderId);
  files.sort((a, b) => {
    const aFolder = a.mimeType === FOLDER_MIME_TYPE;
    const bFolder = b.mimeType === FOLDER_MIME_TYPE;
    if (aFolder !== bFolder) return aFolder ? -1 : 1;
    return a.name.localeCompare(b.name, "ru");
  });

  for (const file of files) {
    if (entries.length >= MAX_ITEMS) break;
    const isFolder = file.mimeType === FOLDER_MIME_TYPE;
    const path = folderPath ? `${folderPath}/${file.name}` : file.name;
    entries.push({
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      path,
      isFolder,
      depth,
    });
    if (isFolder) {
      await listTree(file.id, path, depth + 1, maxDepth, entries);
    }
  }
}

export const listConfiguredRoot = action({
  args: {
    maxDepth: v.optional(v.number()),
  },
  handler: async (_ctx, args): Promise<DriveLibraryEntry[]> => {
    const folderId =
      process.env.GOOGLE_DRIVE_LIBRARY_FOLDER_ID ||
      process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
    if (!folderId) throw new Error("GOOGLE_DRIVE_LIBRARY_FOLDER_ID not set");

    const entries: DriveLibraryEntry[] = [];
    await listTree(
      folderId,
      "",
      0,
      Math.min(args.maxDepth ?? DEFAULT_MAX_DEPTH, DEFAULT_MAX_DEPTH),
      entries
    );
    return entries;
  },
});
