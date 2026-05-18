"use node";

import { SignJWT, importPKCS8 } from "jose";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const SCOPES = "https://www.googleapis.com/auth/drive.file";
const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

function normalizePrivateKey(value: string) {
  let key = value.trim();
  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1);
  }
  return key.replace(/\\n/g, "\n");
}

async function getAccessToken(): Promise<string> {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;
  if (!email || !privateKey) {
    throw new Error("Google service account credentials not configured");
  }

  const key = await importPKCS8(normalizePrivateKey(privateKey), "RS256");
  const jwt = await new SignJWT({
    scope: SCOPES,
  })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(email)
    .setAudience("https://oauth2.googleapis.com/token")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key);

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Google OAuth failed: ${err}`);
  }

  const data = await res.json();
  return data.access_token;
}

function readableDriveError(prefix: string, err: string) {
  if (err.includes("storageQuotaExceeded") || err.includes("Service Accounts do not have storage quota")) {
    return `${prefix}: сервисному аккаунту нужен Shared Drive или OAuth-доступ пользователя; в обычном My Drive у него нет квоты на создание файлов.`;
  }
  return `${prefix}: ${err}`;
}

export async function createFolder(
  name: string,
  parentFolderId: string
): Promise<string> {
  const token = await getAccessToken();

  const res = await fetch(`${DRIVE_API}/files?supportsAllDrives=true&fields=id`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name,
      mimeType: FOLDER_MIME_TYPE,
      parents: [parentFolderId],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(readableDriveError("Google Drive create folder failed", err));
  }

  const data = await res.json();
  return data.id;
}

export async function uploadFile(
  fileName: string,
  buffer: Buffer,
  mimeType: string,
  folderId: string
): Promise<string> {
  const token = await getAccessToken();

  const metadata = JSON.stringify({
    name: fileName,
    parents: [folderId],
  });

  const boundary = "tender_master_boundary";
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`
    ),
    buffer,
    Buffer.from(`\r\n--${boundary}--`),
  ]);

  const res = await fetch(
    `${UPLOAD_API}/files?uploadType=multipart&fields=id&supportsAllDrives=true`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(readableDriveError("Google Drive upload failed", err));
  }

  const data = await res.json();
  return data.id;
}

export async function updateFile(
  fileId: string,
  fileName: string,
  buffer: Buffer,
  mimeType: string
): Promise<string> {
  const token = await getAccessToken();

  const metadata = JSON.stringify({ name: fileName });
  const boundary = "tender_master_boundary";
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`
    ),
    buffer,
    Buffer.from(`\r\n--${boundary}--`),
  ]);

  const res = await fetch(
    `${UPLOAD_API}/files/${fileId}?uploadType=multipart&fields=id&supportsAllDrives=true`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(readableDriveError("Google Drive update failed", err));
  }

  const data = await res.json();
  return data.id;
}

export async function uploadOrReplaceFile(
  fileName: string,
  buffer: Buffer,
  mimeType: string,
  folderId: string
): Promise<string> {
  const existing = (await listFiles(folderId)).find(
    (file) =>
      file.name === fileName &&
      file.mimeType !== FOLDER_MIME_TYPE
  );

  if (existing) {
    return await updateFile(existing.id, fileName, buffer, mimeType);
  }

  return await uploadFile(fileName, buffer, mimeType, folderId);
}

export async function downloadFile(driveFileId: string): Promise<Buffer> {
  const token = await getAccessToken();

  const res = await fetch(`${DRIVE_API}/files/${driveFileId}?alt=media&supportsAllDrives=true`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(readableDriveError("Google Drive download failed", err));
  }

  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export async function listFiles(
  folderId: string
): Promise<Array<{ id: string; name: string; mimeType: string }>> {
  const token = await getAccessToken();

  const query = `'${folderId}' in parents and trashed = false`;
  const res = await fetch(
    `${DRIVE_API}/files?q=${encodeURIComponent(query)}&fields=files(id,name,mimeType)&supportsAllDrives=true&includeItemsFromAllDrives=true`,
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(readableDriveError("Google Drive list failed", err));
  }

  const data = await res.json();
  return data.files || [];
}

export async function findOrCreateFolder(
  name: string,
  parentFolderId: string
): Promise<string> {
  const existing = (await listFiles(parentFolderId)).find(
    (file) =>
      file.name === name &&
      file.mimeType === FOLDER_MIME_TYPE
  );

  if (existing) return existing.id;
  return await createFolder(name, parentFolderId);
}
