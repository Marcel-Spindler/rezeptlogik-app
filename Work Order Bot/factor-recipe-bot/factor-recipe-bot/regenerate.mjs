// Re-render the combined HTML from already-gathered JSON + already-committed run numbers
// (report-w32.json), WITHOUT touching generated-wos.json again — used when only the
// HTML/CSS/PDF output needs fixing after the state file was already updated once.
import fs from 'fs';
import path from 'path';
import { cardsHtml, wrapDocument } from './build-html.mjs';

const DIR = 'C:\\Users\\MatteoSpessotto\\Desktop\\Aiuto Claude\\factor-recipe-bot';
const report = JSON.parse(fs.readFileSync(path.join(DIR, 'report-w32.json'), 'utf8'));

let allCards = '';
for (const g of report) {
  const file = path.join(DIR, 'gathered', `gather-${g.recCode}-${g.date.replace(/[^0-9a-zA-Z-]/g, '_')}.json`);
  const { rec, subs, cache } = JSON.parse(fs.readFileSync(file, 'utf8'));
  allCards += cardsHtml(rec, subs, cache, `RUN ${g.runN}`);
}
const html = wrapDocument(allCards);
const htmlPath = path.join(DIR, 'combined-w32.html');
fs.writeFileSync(htmlPath, html);
console.log('HTML written:', htmlPath, '- recipes:', report.length);
