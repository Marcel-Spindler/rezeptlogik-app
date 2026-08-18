import { readFileSync } from 'fs';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

const PDF = 'G:\\Shared drives\\Recipe  Bible\\Recipes Wednesday 12.08.2026 1631.pdf';
const buf = readFileSync(PDF);
const data = new Uint8Array(buf);
const doc = await pdfjsLib.getDocument({ data }).promise;
for (let i = 1; i <= doc.numPages; i++) {
  const page = await doc.getPage(i);
  const content = await page.getTextContent();
  const text = content.items.map(it => it.str).join(' ');
  console.log(`=== PAGE ${i} ===`);
  console.log(text.slice(0, 300));
  console.log();
}
