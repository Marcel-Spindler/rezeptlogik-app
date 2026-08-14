import { google } from "googleapis";
import fs from "node:fs/promises";
import path from "node:path";

const folderId = process.argv[2];
const names = process.argv.slice(3);
const outDir = path.resolve("scratch", "drive-kw34");
await fs.mkdir(outDir, { recursive: true });
const auth = new google.auth.GoogleAuth({ keyFile: path.resolve("secrets/service-account.json"), scopes: ["https://www.googleapis.com/auth/drive.readonly"] });
const drive = google.drive({ version: "v3", auth });
const files = (await drive.files.list({ q: `'${folderId}' in parents and trashed=false`, fields: "files(id,name,mimeType)", pageSize: 1000, supportsAllDrives: true, includeItemsFromAllDrives: true })).data.files ?? [];
for (const name of names) {
  const file = files.find((item) => item.name === name);
  if (!file) { console.warn(`Nicht gefunden: ${name}`); continue; }
  const safe = name.replace(/[^a-zA-Z0-9._-]+/g, "_");
  const out = path.join(outDir, safe + (file.mimeType === "application/vnd.google-apps.document" ? ".txt" : ""));
  if (file.mimeType === "application/vnd.google-apps.document") {
    const response = await drive.files.export({ fileId: file.id, mimeType: "text/plain" }, { responseType: "text" });
    await fs.writeFile(out, response.data);
  } else {
    const response = await drive.files.get({ fileId: file.id, alt: "media", supportsAllDrives: true }, { responseType: "arraybuffer" });
    await fs.writeFile(out, Buffer.from(response.data));
  }
  console.log(JSON.stringify({ name, id: file.id, mimeType: file.mimeType, output: out }));
}
