import { readFileSync } from 'fs';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

const PDF = 'G:\\Shared drives\\Recipe  Bible\\Recipes Wednesday 12.08.2026 1631.pdf';
const buf = readFileSync(PDF);
const data = new Uint8Array(buf);
const doc = await pdfjsLib.getDocument({ data }).promise;
console.log(`Pages: ${doc.numPages}`);
const allWOs = new Set();
for (let i = 1; i <= doc.numPages; i++) {
  const page = await doc.getPage(i);
  const content = await page.getTextContent();
  const text = content.items.map(it => it.str).join(' ');
  const wos = [...new Set((text.match(/34-\d+/g) || []))];
  if (wos.length) console.log(`  p${i}: ${wos.join(', ')}`);
  wos.forEach(w => allWOs.add(w));
}
const sorted = [...allWOs].sort((a,b)=>parseInt(a.split('-')[1])-parseInt(b.split('-')[1]));
console.log(`\nAll WOs in new PDF (${sorted.length}):`, sorted.join(', '));
