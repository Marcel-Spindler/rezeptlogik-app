const { PDFParse } = require('pdf-parse');
const pdfParse = (buf) => new PDFParse().parse(buf);
const fs = require('fs');
const KW33 = 'G:/Shared drives/Recipe  Bible/KW 33';

async function run() {
  const files = [
    'Recipes Thursday 06.08.2026 - New WOs Rework.pdf',
    'Recipes Thursday 06.08.2026.pdf'
  ];
  for (const f of files) {
    const buf = fs.readFileSync(KW33 + '/' + f);
    const data = await pdfParse(buf);
    const lines = data.text.split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 4 && /FV\d|Run \d+|WO \d|Salmon|Chicken|Beef|Barramundi|Baja|Zaatar|Chili|Gochugaru|Rosemary|Greek|Curry|Pulled|Carameliz|Pot Roast|Jeweled|Fondue|Ragu|Shredded|Mash/i.test(l));
    console.log('\n=== ' + f + ' ===');
    [...new Set(lines)].slice(0, 60).forEach(l => console.log('  ' + l));
  }
}
run().catch(e => { console.error(e.message); process.exit(1); });
