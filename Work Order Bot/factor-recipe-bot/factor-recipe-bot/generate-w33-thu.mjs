import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { cardsHtml, wrapDocument } from './build-html.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const groups = JSON.parse(fs.readFileSync(path.join(__dir, 'groups-new-w33-thu.json'), 'utf8'));
const statePath = path.join(__dir, 'generated-wos.json');
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));

const OUT_DIR = 'G:\\Shared drives\\Recipe  Bible';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const TEMP_DIR = path.join(__dir, 'temp-html');
fs.mkdirSync(TEMP_DIR, { recursive: true });

const TODAY = '2026-08-03';
const now = new Date();
const hhmm = String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0');

const DAY_INFO = {
  'Tuesday':   { dateStr: '04.08.2026' },
  'Wednesday': { dateStr: '05.08.2026' },
  'Thursday':  { dateStr: '06.08.2026' },
};

const byDay = {};
for (const g of groups) {
  (byDay[g.day] ||= []).push(g);
}

for (const [day, dayGroups] of Object.entries(byDay)) {
  console.log(`\n=== ${day} (${DAY_INFO[day].dateStr}) — ${dayGroups.length} recipes ===`);
  let allCards = '';

  for (const g of dayGroups) {
    const safeDateStr = g.date.replace(/[^0-9a-zA-Z-]/g, '_');
    const file = path.join(__dir, 'gathered', `gather-w33-${g.recCode}-${safeDateStr}.json`);
    if (!fs.existsSync(file)) { console.error('  MISSING:', file); continue; }
    const { rec, subs, cache } = JSON.parse(fs.readFileSync(file, 'utf8'));
    const runN = (state.runCount[g.recCode] || 0) + 1;
    const newSet = new Set(g.wos);
    const filteredSubs = subs.filter(s => s.wo && newSet.has(s.wo));
    allCards += cardsHtml(rec, filteredSubs, cache, `RUN ${runN}`);
    g.wos.forEach(w => { state.doneWO[w] = TODAY; });
    state.runCount[g.recCode] = runN;
    console.log(`  ${g.recCode}: Run ${runN}, ${filteredSubs.length} cards`);
  }

  if (!allCards) { console.error('  No cards, skipping'); continue; }
  const html = wrapDocument(allCards);
  const htmlPath = path.join(TEMP_DIR, `w33-${day.toLowerCase()}-thu.html`);
  fs.writeFileSync(htmlPath, html, 'utf8');

  const pdfName = `Recipes ${day} ${DAY_INFO[day].dateStr} ${hhmm}.pdf`;
  const pdfPath = path.join(OUT_DIR, pdfName);
  console.log(`  Printing: ${pdfName}`);
  try {
    execFileSync(CHROME, [
      '--headless=new', '--disable-gpu', '--no-pdf-header-footer',
      `--print-to-pdf=${pdfPath}`,
      `file:///${htmlPath.replace(/\\/g, '/')}`
    ], { timeout: 60000 });
    const size = fs.statSync(pdfPath).size;
    console.log(`  -> ${pdfPath} (${Math.round(size/1024)} KB)`);
  } catch (e) {
    console.error('  Chrome error:', e.message);
  }
}

state._note = `W33 run ${TODAY} Thu-batch: Tue(1 recipe, 5 WOs), Wed(6 recipes, 34 WOs), Thu(2 recipes, 10 WOs). 3 PDFs.`;
fs.writeFileSync(statePath, JSON.stringify(state, null, 1));
console.log('\nDone. generated-wos.json updated.');
