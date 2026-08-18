import { getDocument } from './node_modules/pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'fs';

async function readPDF(filePath) {
  const buf = fs.readFileSync(filePath);
  const doc = await getDocument({ data: new Uint8Array(buf) }).promise;
  let text = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map(it => it.str).join(' ') + '\n';
  }
  return text;
}

const KW33 = 'G:/Shared drives/Recipe  Bible/KW 33';
const files = [
  'Recipes Thursday 06.08.2026 - New WOs Rework.pdf',
  'Recipes Thursday 06.08.2026.pdf',
];

for (const f of files) {
  const text = await readPDF(KW33 + '/' + f);
  const matches = [...new Set(
    text.split('\n').flatMap(l => l.split('  '))
      .map(s => s.trim())
      .filter(s => s.length > 5 && /FV\d|Salmon|Chicken|Beef|Barramundi|Baja|Zaatar|Chili|Gochugaru|Rosemary|Greek|Curry|Pulled|Carameliz|Pot Roast|Jeweled|Fondue|Ragu|Mash/i.test(s))
  )];
  console.log('\n=== ' + f + ' ===');
  // Extract recipe header lines (FV codes)
  const fvLines = [...new Set(
    text.split('\n').flatMap(l => l.split('  '))
      .map(s => s.trim())
      .filter(s => /^FV\d/.test(s))
  )];
  console.log('RECIPES IN THIS PDF:');
  fvLines.forEach(m => console.log('  ' + m));
  console.log('OTHER MATCHES:');
  matches.filter(m => !/^FV\d/.test(m)).slice(0, 20).forEach(m => console.log('  ' + m));
}
