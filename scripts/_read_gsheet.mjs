import { google } from 'googleapis';
const auth = new google.auth.GoogleAuth({ keyFile: 'secrets/service-account.json', scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
const sheets = google.sheets({ version: 'v4', auth });
const SHEET_ID = '1VRy_bAGXr4TaGPM2D8dsD6YtY2-RWpgyooUQViQEPQs';

const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID, fields: 'sheets.properties' });
console.log('=== TABS ===');
for (const s of meta.data.sheets ?? []) {
  console.log(`  ${s.properties?.index}\t${s.properties?.gid ?? s.properties?.sheetId}\t${s.properties?.title}\t(${s.properties?.gridProperties?.rowCount} rows)`);
}
