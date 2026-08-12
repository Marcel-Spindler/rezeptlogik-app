const fs = require('fs');
const path = require('path');
const base = 'g:\\.shortcut-targets-by-id\\1zfewj0K82lGP0tj6S3M2ZsL9UEQ73iAa\\DE_02_Operational Data Exchange\\DE_02_09_Produktionsplanung\\2026-W34\\02_Factor Planning';
const deFile = path.join(base, 'FACTOR_DE\\RackFile\\Rackfile_[Combine2026-W34]_[F-DE]_[ASL3,4] - Rackfile_[Combine2026-W34].csv');
const noFile = path.join(base, 'FACTOR_NO\\RackFile\\Rackfile_[Comb2026-W34]_[F-Nordics]_[ASL1,5].csv');
console.log('=== DE W34 ===');
console.log(fs.readFileSync(deFile, 'utf8'));
console.log('\n=== NO W34 ===');
console.log(fs.readFileSync(noFile, 'utf8'));
