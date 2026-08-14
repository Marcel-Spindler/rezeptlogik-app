import { google } from "googleapis";
import path from "node:path";

const folderId = process.argv[2];
if (!folderId) throw new Error("Ordner-ID fehlt");

const auth = new google.auth.GoogleAuth({
  keyFile: path.resolve("secrets/service-account.json"),
  scopes: ["https://www.googleapis.com/auth/drive.readonly"],
});
const drive = google.drive({ version: "v3", auth });
const folder = await drive.files.get({
  fileId: folderId,
  fields: "id,name,mimeType,driveId,parents,owners,permissions",
  supportsAllDrives: true,
});
console.error(JSON.stringify({ folder: folder.data, serviceAccount: "pdl-fast-reader@hellofresh-de-problem-solve.iam.gserviceaccount.com" }, null, 2));
const files = [];
let pageToken;
do {
  const result = await drive.files.list({
    q: `'${folderId}' in parents and trashed=false`,
    fields: "nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink)",
    pageSize: 1000,
    orderBy: "name",
    pageToken,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  files.push(...(result.data.files ?? []));
  pageToken = result.data.nextPageToken;
} while (pageToken);
console.log(JSON.stringify(files, null, 2));
