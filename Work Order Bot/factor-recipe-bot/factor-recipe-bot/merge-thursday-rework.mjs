import fs from 'fs';
import { PDFDocument } from 'pdf-lib';

const dir = 'G:/Shared drives/Recipe  Bible';
const files = [
  'FV0281A - Baja Salmon [DE] - Run 2.pdf',
  'FV0401A - Pulled chicken with cheddar and bacon [DE] - Run 9.pdf',
  'FV0970A - Caramelized Onion & Emmental Fondue Chicken [DE] - Run 4.pdf',
  'FV1169A - [DE] -Salmon and sweet soy dressing - Run 3.pdf',
  'FV1347A - Pot Roast Shredded Beef & Mash [DE] - Run 3.pdf',
  'FV1481B - [DE] - Thai Coconut Curry Barramundi - Run 2.pdf',
  'FV4065B- Spicy Beef & Black Bean Chili [DE] - Run 4.pdf',
  'FV4096B Zaatar Rub Salmon & Jeweled Rice [DE] - Run 7.pdf',
];

const merged = await PDFDocument.create();
for (const f of files) {
  const bytes = fs.readFileSync(`${dir}/${f}`);
  const src = await PDFDocument.load(bytes);
  const pages = await merged.copyPages(src, src.getPageIndices());
  pages.forEach(p => merged.addPage(p));
  console.log('added', f, '-', src.getPageCount(), 'pages');
}

const outName = 'Recipes Thursday 06.08.2026 - New WOs Rework.pdf';
const outBytes = await merged.save();
fs.writeFileSync(`${dir}/${outName}`, outBytes);
console.log('\nWrote', outName, outBytes.length, 'bytes,', merged.getPageCount(), 'total pages');

for (const f of files) {
  fs.unlinkSync(`${dir}/${f}`);
  console.log('deleted', f);
}
