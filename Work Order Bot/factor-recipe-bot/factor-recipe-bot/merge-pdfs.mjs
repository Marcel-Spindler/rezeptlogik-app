import { PDFDocument } from 'pdf-lib';
import fs from 'fs';
import path from 'path';

const ROOT = 'G:/Shared drives/Recipe  Bible';
const OUT  = path.join(ROOT, 'Wednesday 05.08.2026 + Thursday Shift2 - New WOs.pdf');

const FILES = [
  'FV0257A - Greek style ground beef and feta [DE] - Run 8.pdf',
  'FV0485A - Rosemary-tomato chicken - [DE] - Run 8.pdf',
  'FV4053A - Gochugaru Chicken [DE] - Run 4.pdf',
  'FV0401A - Pulled chicken with cheddar and bacon [DE] - Run 10.pdf',
];

const merged = await PDFDocument.create();

for (const f of FILES) {
  const buf = fs.readFileSync(path.join(ROOT, f));
  const src = await PDFDocument.load(buf);
  const pages = await merged.copyPages(src, src.getPageIndices());
  pages.forEach(p => merged.addPage(p));
  console.log(`Added: ${f} (${src.getPageCount()} pages)`);
}

const bytes = await merged.save();
fs.writeFileSync(OUT, bytes);
console.log(`\nSaved: ${path.basename(OUT)} (${merged.getPageCount()} pages total, ${(bytes.length/1024).toFixed(0)} KB)`);
