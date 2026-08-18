// Generate one PDF per production day for W33 new WOs.
// Reads gathered/gather-w33-*.json files, combines cards by day, prints via Chrome headless.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { cardsHtml, wrapDocument } from './build-html.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const groups = JSON.parse(fs.readFileSync(path.join(__dir, 'groups-new-w33.json'), 'utf8'));
const statePath = path.join(__dir, 'generated-wos.json');
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));

const OUT_DIR = 'G:\\Shared drives\\Recipe  Bible';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const TEMP_DIR = path.join(__dir, 'temp-html');
fs.mkdirSync(TEMP_DIR, { recursive: true });

const TODAY = '2026-07-31';
const now = new Date();
const hhmm = String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0');

const DAY_INFO = {
  'Monday':    { dateStr: '03.08.2026' },
  'Tuesday':   { dateStr: '04.08.2026' },
  'Wednesday': { dateStr: '05.08.2026' },
};

// Group recipe groups by day
const byDay = {};
for (const g of groups) {
  (byDay[g.day] ||= []).push(g);
}

for (const [day, dayGroups] of Object.entries(byDay)) {
  console.log(`\n=== ${day} (${DAY_INFO[day].dateStr}) — ${dayGroups.length} recipes ===`);
  let allCards = '';
  const report = [];

  for (const g of dayGroups) {
    const safeDateStr = g.date.replace(/[^0-9a-zA-Z-]/g, '_');
    const file = path.join(__dir, 'gathered', `gather-w33-${g.recCode}-${safeDateStr}.json`);
    if (!fs.existsSync(file)) { console.error('  MISSING gathered file:', file); continue; }
    const { rec, subs, cache } = JSON.parse(fs.readFileSync(file, 'utf8'));
    const runN = (state.runCount[g.recCode] || 0) + 1;
    const newSet = new Set(g.wos);
    const filteredSubs = subs.filter(s => s.wo && newSet.has(s.wo));
    allCards += cardsHtml(rec, filteredSubs, cache, `RUN ${runN}`);
    report.push({ recCode: g.recCode, recName: rec.name, runN, subs: filteredSubs.map(s => s.name + ' (WO ' + s.wo + ')') });
    g.wos.forEach(w => { state.doneWO[w] = TODAY; });
    state.runCount[g.recCode] = runN;
    console.log(`  ${g.recCode}: Run ${runN}, ${filteredSubs.length} sub-recipe cards`);
  }

  if (!allCards) { console.error('  No cards generated, skipping PDF'); continue; }
  const html = wrapDocument(allCards);
  const htmlPath = path.join(TEMP_DIR, `w33-${day.toLowerCase()}.html`);
  fs.writeFileSync(htmlPath, html, 'utf8');

  const pdfName = `Recipes ${day} ${DAY_INFO[day].dateStr} ${hhmm}.pdf`;
  const pdfPath = path.join(OUT_DIR, pdfName);
  console.log(`  Printing PDF: ${pdfName}`);
  try {
    execFileSync(CHROME, [
      '--headless=new', '--disable-gpu', '--no-pdf-header-footer',
      `--print-to-pdf=${pdfPath}`,
      `file:///${htmlPath.replace(/\\/g, '/')}`
    ], { timeout: 60000 });
    console.log(`  -> ${pdfPath}`);
  } catch (e) {
    console.error('  Chrome PDF error:', e.message);
  }
}

state._note = `W33 run ${TODAY}: Mon(6 recipes, 33 WOs), Tue(6 recipes, 30 WOs), Wed(1 recipe, 7 WOs). Split by day — 3 PDFs. Gathered via Node fetch + build-html.mjs.`;
fs.writeFileSync(statePath, JSON.stringify(state, null, 1));
console.log('\nDone. generated-wos.json updated.');
