import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFDocument } from 'pdf-lib';

const NEW_PDF = 'G:\\Shared drives\\Recipe  Bible\\Recipes Wednesday 12.08.2026 1631.pdf';
const OLD_PDF = 'C:\\Users\\MatteoSpessotto\\Downloads\\Recipes Wednesday 12.08.2026 - New.pdf';
const OUT_PDF = 'G:\\Shared drives\\Recipe  Bible\\Recipes Wednesday 12.08.2026 1631.pdf'; // overwrite

// WOs already in the old PDF (from extraction)
const OLD_WOS = new Set([
  '34-6','34-7','34-8','34-9','34-10',
  '34-16','34-17','34-18','34-19','34-20',
  '34-102','34-104','34-105',
  '34-128','34-130','34-131','34-132','34-133',
  '34-140','34-141','34-142','34-143','34-144','34-145',
  '34-167'
]);

// New WOs (NOT in old PDF)
const NEW_WOS = new Set([
  '34-166','34-170','34-172',
  '34-173','34-174','34-175',
  '34-176','34-177','34-178',
  '34-179'
]);

// 1. Identify pages in new PDF that belong to new WOs only
const buf = readFileSync(NEW_PDF);
const data = new Uint8Array(buf);
const doc = await pdfjsLib.getDocument({ data }).promise;

console.log(`New PDF: ${doc.numPages} pages`);

// For each page, extract WO numbers found
const pageWOs = [];
for (let i = 1; i <= doc.numPages; i++) {
  const page = await doc.getPage(i);
  const content = await page.getTextContent();
  const text = content.items.map(it => it.str).join(' ');
  const wos = [...new Set((text.match(/34-\d+/g) || []))];
  pageWOs.push({ page: i, wos, text: text.slice(0, 80) });
}

// A page belongs to "new" if it contains at least one NEW WO and zero OLD WOs
// (some pages may be header/continuation pages with no WO - include them if
//  their surrounding pages are new)
// Strategy: group consecutive pages by recipe block, then decide per block
// Simpler: page is "new only" if it has a new WO OR (no WO at all AND previous page was new)
const keepPages = [];
let prevWasNew = false;
for (const p of pageWOs) {
  const hasOld = p.wos.some(w => OLD_WOS.has(w));
  const hasNew = p.wos.some(w => NEW_WOS.has(w));
  const hasAny = p.wos.length > 0;

  if (hasNew && !hasOld) {
    keepPages.push(p.page);
    prevWasNew = true;
  } else if (!hasAny && prevWasNew) {
    // Continuation page (e.g. ingredient table overflow) - keep with block
    keepPages.push(p.page);
  } else {
    prevWasNew = false;
  }
}

console.log(`Pages to keep (new WOs only): ${keepPages.length} of ${doc.numPages}`);
keepPages.forEach(pg => {
  const p = pageWOs[pg-1];
  console.log(`  p${pg}: WOs=${p.wos.join(',') || 'none'}`);
});

if (keepPages.length === 0) {
  console.error('No pages found for new WOs — aborting');
  process.exit(1);
}

// 2. Build new PDF with only those pages using pdf-lib
const srcDoc = await PDFDocument.load(buf);
const outDoc = await PDFDocument.create();

const copied = await outDoc.copyPages(srcDoc, keepPages.map(p => p - 1)); // 0-indexed
for (const page of copied) outDoc.addPage(page);

const outBytes = await outDoc.save();

// Overwrite the G:\ PDF
writeFileSync(OUT_PDF, outBytes);
console.log(`\nSaved: ${OUT_PDF} (${keepPages.length} pages)`);

// 3. Delete the old Downloads PDF
if (existsSync(OLD_PDF)) {
  unlinkSync(OLD_PDF);
  console.log(`Deleted: ${OLD_PDF}`);
} else {
  console.log(`Not found (skip delete): ${OLD_PDF}`);
}

console.log('\nDone.');
