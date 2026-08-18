import fs from 'fs';
import path from 'path';
import { cardsHtml, wrapDocument } from './build-html.mjs';

const DIR = 'C:\\Users\\MatteoSpessotto\\Desktop\\Aiuto Claude\\factor-recipe-bot';
const groups = JSON.parse(fs.readFileSync(path.join(DIR, 'groups-new-w32.json'), 'utf8'));
const state = JSON.parse(fs.readFileSync(path.join(DIR, 'generated-wos.json'), 'utf8').replace(/^\uFEFF/, ''));

let allCards = '';
const report = [];
for (const g of groups) {
  const file = path.join(DIR, 'gathered', `gather-${g.recCode}-${g.date.replace(/[^0-9a-zA-Z-]/g, '_')}.json`);
  const { rec, subs, cache } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const runN = (state.runCount[g.recCode] || 0) + 1;
  const isRework = (state.runCount[g.recCode] || 0) > 0;
  allCards += cardsHtml(rec, subs, cache, `RUN ${runN}`);
  report.push({ recCode: g.recCode, recName: rec.name, date: g.date, runN, isRework, subs: subs.map(s => s.name + ' (WO ' + s.wo + ')') });
  g.wos.forEach(w => { state.doneWO[w] = '2026-07-28'; });
  state.runCount[g.recCode] = runN;
}
const html = wrapDocument(allCards);
const htmlPath = path.join(DIR, 'combined-w32.html');
fs.writeFileSync(htmlPath, html);
state._note = 'W32 run 2026-07-28 (13:00): 4 recipes Wed29-shift2 rollover (1 WO each, partial), 9 recipes Thu30-shift1 (full new). 52 new WOs. Dedup by WO number.';
fs.writeFileSync(path.join(DIR, 'generated-wos.json'), JSON.stringify(state, null, 1));
fs.writeFileSync(path.join(DIR, 'report-w32.json'), JSON.stringify(report, null, 1));
console.log('Cards:', report.length, '-> pages:', groups.reduce((a, g) => a + g.newWOs.length, 0));
console.log('HTML written:', htmlPath);
