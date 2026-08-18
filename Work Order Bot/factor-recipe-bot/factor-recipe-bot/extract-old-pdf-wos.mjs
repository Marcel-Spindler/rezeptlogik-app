import { readFileSync } from 'fs';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

const buf = readFileSync('C:\\Users\\MatteoSpessotto\\Downloads\\Recipes Wednesday 12.08.2026 - New.pdf');
const data = new Uint8Array(buf);
const doc = await pdfjsLib.getDocument({ data }).promise;
let fullText = '';
for (let i = 1; i <= doc.numPages; i++) {
  const page = await doc.getPage(i);
  const content = await page.getTextContent();
  fullText += content.items.map(it => it.str).join(' ') + '\n';
}
const wos = [...new Set((fullText.match(/34-\d+/g) || []))];
wos.sort((a,b) => parseInt(a.split('-')[1]) - parseInt(b.split('-')[1]));
console.log('Pages:', doc.numPages);
console.log('WOs old PDF:', wos.length);
console.log(JSON.stringify(wos));
