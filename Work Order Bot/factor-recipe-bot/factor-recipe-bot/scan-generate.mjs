import fs from 'fs';
import path from 'path';
import { cardsHtml, wrapDocument } from './build-html.mjs';

const DIR = 'C:\\Users\\MatteoSpessotto\\Desktop\\Aiuto Claude\\factor-recipe-bot';
const groups = JSON.parse(fs.readFileSync(path.join(DIR, 'scan-w32-new.json'), 'utf8'));
const state = JSON.parse(fs.readFileSync(path.join(DIR, 'generated-wos.json'), 'utf8').replace(/^\uFEFF/, ''));

let allCards = '';
const report = [];
for (const g of groups) {
  const file = path.join(DIR, 'gathered', `scan-${g.recCode}-${g.date.replace(/[^0-9a-zA-Z-]/g, '_')}.json`);
  const { rec, subs, cache } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const runN = (state.runCount[g.recCode] || 0) + 1;
  const isRework = (state.runCount[g.recCode] || 0) > 0;
  allCards += cardsHtml(rec, subs, cache, `RUN ${runN}`);
  report.push({ recCode: g.recCode, recName: rec.name, date: g.date, runN, isRework, subs: subs.map(s => s.name + ' (WO ' + s.wo + ')') });
  g.wos.forEach(w => { state.doneWO[w] = '2026-07-29'; });
  state.runCount[g.recCode] = runN;
}
const html = wrapDocument(allCards);
fs.writeFileSync(path.join(DIR, 'combined-scan-w32.html'), html);
state._note = 'W32 scan 2026-07-29 17:24 (Wed): 7 recipes, 12 new WOs (Wed29-shift2 topups, Thu30-shift2 new, Fri31-shift2 over-plating). Per-sub target-portions grouping fix applied (see SKILL.md §9bis).';
fs.writeFileSync(path.join(DIR, 'generated-wos.json'), JSON.stringify(state, null, 1));
fs.writeFileSync(path.join(DIR, 'report-scan-w32.json'), JSON.stringify(report, null, 1));
console.log('Cards:', report.length, '-> pages:', groups.reduce((a, g) => a + g.wos.filter(w=>true).length, 0));
console.log(JSON.stringify(report.map(r=>({r:r.recCode, run:r.runN, n:r.subs.length})), null, 0));
