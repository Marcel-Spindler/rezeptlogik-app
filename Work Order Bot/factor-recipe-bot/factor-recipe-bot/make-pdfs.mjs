// Generates PDF for NEW Wednesday recipes only (not yet in doneWO)
// Saves to G:\Shared drives\Recipe  Bible\KW 34\
// Usage: node make-pdfs.mjs [path-to-json]
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));

const jsonPath = process.argv[2] ||
  path.join(process.env.USERPROFILE, 'Downloads', 'factor-w34-html.json');

const ROOT_DIR = process.env.FACTOR_OUT || 'G:\\Shared drives\\Recipe  Bible';
const KW34_DIR = path.join(ROOT_DIR, 'KW 34');

if (!fs.existsSync(jsonPath)) {
  console.error('JSON file not found:', jsonPath);
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
const groups = data.groups || [];

// Load doneWO to know which groups are already printed
const stateFile = path.join(__dir, 'generated-wos.json');
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const doneWO = new Set(Object.keys(state.doneWO || {}));

// Extract helpers
function extractCss(html) {
  const m = html.match(/<style>([\s\S]*?)<\/style>/);
  return m ? m[1] : '';
}
function extractBody(html) {
  const m = html.match(/<body>([\s\S]*?)<\/body>/);
  return m ? m[1].trim() : html;
}

// Find NEW Wednesday groups: groups whose WOs are NOT all already done
const wedNew = groups.filter(g => {
  if (g.day !== 'Wednesday') return false;
  const wos = g.wos || [];
  // A group is "new" if NONE of its WOs appear in doneWO
  return wos.every(wo => !doneWO.has(wo));
});

console.log(`Wednesday groups: ${groups.filter(g => g.day === 'Wednesday').length} total, ${wedNew.length} new`);
wedNew.forEach(g => console.log(`  → ${g.filename}  WOs: ${(g.wos||[]).join(', ')}`));

if (wedNew.length === 0) {
  console.log('Nothing new to generate.');
  process.exit(0);
}

const css = extractCss(groups[0]?.html || '');
fs.mkdirSync(KW34_DIR, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage();

// Build combined HTML for new Wednesday groups
const bodyParts = wedNew.map(g => extractBody(g.html));
const combined = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${bodyParts.join('\n')}</body></html>`;

const pdfName = 'Recipes Wednesday 12.08.2026 - New';
const pdfPath = path.join(KW34_DIR, pdfName + '.pdf');

try {
  await page.setContent(combined, { waitUntil: 'domcontentloaded' });
  await page.pdf({
    path: pdfPath,
    format: 'A4',
    printBackground: true,
    margin: { top: '9mm', bottom: '9mm', left: '9mm', right: '9mm' },
  });
  console.log(`\n✓ Saved: ${pdfPath}`);
} catch (e) {
  console.error(`✗ Failed: ${e.message}`);
}

await browser.close();

// Delete unnecessary PDFs created this session from the root
const toDelete = [
  path.join(ROOT_DIR, 'Monday 10.08.2026 - W34.pdf'),
  path.join(ROOT_DIR, 'Tuesday 11.08.2026 - W34.pdf'),
  path.join(ROOT_DIR, 'Wednesday 12.08.2026 - W34.pdf'),
  path.join(ROOT_DIR, 'FV4034A - [DE] - Pulled chicken in smokey tomato sauce - Run 5.pdf'),
];
console.log('\nCleaning up unnecessary PDFs:');
for (const f of toDelete) {
  if (fs.existsSync(f)) {
    fs.unlinkSync(f);
    console.log(`  ✓ Deleted: ${path.basename(f)}`);
  } else {
    console.log(`  – Not found (skip): ${path.basename(f)}`);
  }
}
console.log('\nDone.');
