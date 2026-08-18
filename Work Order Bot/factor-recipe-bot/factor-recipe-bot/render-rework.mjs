// One-off renderer for the Tuesday 04.08.2026 Shift-2 partial rework (7 WOs, per-sub targets).
// Reuses the validated buildHtml card logic from bot.mjs but with per-job (per-WO) recipe context,
// since a partial rework mixes several recipes each with its own sub-recipe + own target portions.
import fs from 'fs';
import { classify, isSpiceRoom, isSeparate, READY_MADE } from './capacity-rules.js';

const IN = process.argv[2] || 'C:\\Users\\MatteoSpessotto\\Downloads\\rework_martedi_04-08_turno2.json';
const OUT = process.argv[3] || 'C:\\Users\\MatteoSpessotto\\Downloads\\rework_martedi_04-08_turno2.html';
const jobs = JSON.parse(fs.readFileSync(IN, 'utf8'));

// cook methods from the ET CSV (pdf-export returns them empty)
const COOK = {
  '33-184': ['PLANETARY MIXER', 'SCOOPER (BUTTER)'],
  '33-183': ['OVEN'],
  '33-181': [], '33-182': [], '33-180': [],
  '33-178': ['BRAISER', 'HAND MIX', 'IMMERSION BLENDER', 'SPICE PORTIONING'],
  '33-179': ['BRINE', 'IMMERSION BLENDER', 'MARINADE', 'OVEN'],
};

const ALLERGEN_EN = {
  'Milch (einschließlich Laktose)': 'Milk (incl. lactose)', 'Schwefeldioxide und Sulfite': 'Sulphur dioxide & sulphites',
  'Erdnüsse': 'Peanuts', 'Schalenfrüchte': 'Tree nuts', 'Sesamsamen': 'Sesame seeds', 'Soja': 'Soya',
  'Glutenhaltiges Getreide': 'Cereals containing gluten', 'Weizen': 'Wheat', 'Gerste': 'Barley', 'Hafer': 'Oats',
  'Roggen': 'Rye', 'Dinkel': 'Spelt', 'Mandeln': 'Almonds', 'Walnüsse': 'Walnuts', 'Kaschunüsse': 'Cashew nuts',
  'Pistazien': 'Pistachios', 'Sellerie': 'Celery', 'Eier': 'Eggs', 'Senf': 'Mustard', 'Haselnüsse': 'Hazelnuts',
  'Fisch': 'Fish', 'Krebstiere': 'Crustaceans', 'Weichtiere': 'Molluscs', 'Lupinen': 'Lupin',
  'Paranüsse': 'Brazil nuts', 'Pekannüsse': 'Pecans', 'Macadamianüsse': 'Macadamia nuts',
};
const biAllergen = de => ALLERGEN_EN[de] ? `${ALLERGEN_EN[de]} / ${de}` : de;

const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
const fmt = t => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/"([^"]{1,60}?)"/g, '"<span class=setup>$1</span>"').replace(/\n+/g, '<br>');
const q = g => (g == null || isNaN(g)) ? '—' : (g < 1000 ? Math.round(g) + ' g' : (g / 1000).toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' kg');
const nm = n => `${esc(n)}${isSeparate(n) ? ' <span class=sep>SEPARATE</span>' : ''}`;
const qc = (n, g) => `<td class="r">${q(g)}</td>`;
const rowCls = (spice, ...extra) => [...extra, spice ? 'spice' : ''].filter(Boolean).join(' ');
const algBox = c => { if (!c || !c.length) return ''; return `<div class=algBox><div class=algRow><span class=algLc>⚠ CONTAINS</span>${c.map(x => `<span class=badC>${esc(biAllergen(x))}</span>`).join('')}</div></div>`; };
const tableWrap = r => `<table class=ing><thead><tr><th>Ingredient</th><th class=r>Per batch</th><th class=r>Total</th></tr></thead><tbody>${r}</tbody></table>`;
const instrBlock = (en, de, label) => (en || de) ? `<div class=instr><div class=ic><div class=ih>${label ? label + ' — ' : ''}INSTRUCTIONS (EN)</div>${fmt(en) || '—'}</div><div class=ic><div class=ih>${label ? label + ' — ' : ''}ANLEITUNG (DE)</div>${fmt(de) || '—'}</div></div>` : '';
const nmSalt = n => `${esc(n)}${isSeparate(n) ? ' <span class=sep>SEPARATE</span>' : ''}`;
const spiceFirst = (arr) => [...(arr || [])].sort((a, b) => (isSpiceRoom(b.name) ? 1 : 0) - (isSpiceRoom(a.name) ? 1 : 0));

function buildCard(job) {
  const cook = COOK[job.wo] || [];
  const cls = classify(job.sub, cook);
  const rti = cls.rti || (job.bc == null && (job.ings || []).length === 0);
  const B = job.bc || 1;
  const bq = job.bq != null ? Math.ceil(job.bq) : null;
  const totalNeeded = (job.pA || 0) * job.target; // grams (for RTI raw articles)
  const batch = rti ? '<span class=rti>RTI · portion only → Plating</span>' : (job.bc != null ? `<b>${job.bc}</b> × ${bq} kg` : '—');
  const cache = job.cache || {};
  const subD = cache[job.id] || {};
  const isMar = /marinad|marinat|mariniert/i.test((subD.en || '') + (subD.de || ''));

  const expand = (children, depth) => {
    let out = '';
    spiceFirst(children).forEach(x => {
      const ready = READY_MADE.test(x.name);
      const deeper = !ready && x.manuf && (x.children || []).length && depth < 5;
      const tag = ready ? ' <span class=rdy>ready · weekly prep</span>' : (deeper ? ' <span class=tag>sub ↓</span>' : '');
      out += `<tr class="${rowCls(isSpiceRoom(x.name), 'nest')}"><td style="padding-left:${10 + depth * 14}px">↳ ${nm(x.name)}${tag}</td>${qc(x.name, x.g / B)}${qc(x.name, x.g)}</tr>`;
      if (deeper) out += expand(x.children, depth + 1);
    });
    return out;
  };
  const normalRow = i => {
    const ready = i.manuf && READY_MADE.test(i.name);
    const noExp = i.manuf && /yielded/i.test(i.name);
    const isBrine = i.manuf && /brine|brined/i.test(i.name);
    const tag = !i.manuf ? '' : ready ? ' <span class=rdy>ready · weekly prep</span>' : noExp ? '' : isBrine ? ' <span class=brineTag>BRINE ↓</span>' : ' <span class=tag>sub-recipe ↓</span>';
    let out = `<tr class="${rowCls(isSpiceRoom(i.name), i.manuf && !noExp ? 'mf' : '')}"><td>${nm(i.name)}${tag}</td>${qc(i.name, i.g != null ? i.g / B : null)}${qc(i.name, i.g)}</tr>`;
    if (i.manuf && !ready && !noExp && (i.children || []).length) out += expand(i.children, 1);
    return out;
  };

  let body;
  const brinedIng = rti ? null : (job.ings || []).find(i => i.manuf && /brine|brined/i.test(i.name));
  if (brinedIng && isMar) {
    const nb = brinedIng.children || [];
    const proteinG = nb.filter(x => !/salt|salz|water|wasser/i.test(x.name)).reduce((a, x) => a + (x.g || 0), 0);
    const brineRows = spiceFirst(nb).map(x => `<tr class="${rowCls(isSpiceRoom(x.name), '')}"><td>${nmSalt(x.name)}</td>${qc(x.name, x.g / B)}${qc(x.name, x.g)}</tr>`).join('');
    const brineSection = `<div class="secH brine">🧂 BRINE — ${esc(brinedIng.name)}</div>${tableWrap(brineRows)}${instrBlock((cache[brinedIng.id] || {}).en, (cache[brinedIng.id] || {}).de, 'BRINE')}`;
    let marRows = ''; spiceFirst((job.ings || []).filter(i => i !== brinedIng)).forEach(i => { marRows += normalRow(i); });
    marRows += `<tr class="${rowCls(isSpiceRoom(brinedIng.name), 'mf')}"><td>${nm(brinedIng.name)} <span class=brineTag>↑ from BRINE (raw protein, no water)</span></td>${qc(brinedIng.name, proteinG / B)}${qc(brinedIng.name, proteinG)}</tr>`;
    let marInstrExtra = ''; (job.ings || []).forEach(i => { if (i === brinedIng || !i.manuf || READY_MADE.test(i.name) || /yielded/i.test(i.name) || !cache[i.id] || !(cache[i.id].en || cache[i.id].de)) return; const c = cache[i.id]; marInstrExtra += `<div class=nestInstr><div class=nih>↳ ${esc(i.name)} — sub-recipe</div>${instrBlock(c.en, c.de)}</div>`; });
    const marSection = `<div class="secH mar">MARINADE — ${esc(job.sub)}</div>${tableWrap(marRows)}${instrBlock(subD.en, subD.de, 'MARINADE')}${marInstrExtra}`;
    body = brineSection + marSection;
  } else {
    let rows = '';
    if (rti) rows = `<tr class="${rowCls(isSpiceRoom(job.sub), 'mf')}"><td>${nm(job.sub)}</td>${qc(job.sub, totalNeeded)}${qc(job.sub, totalNeeded)}</tr>`;
    else spiceFirst(job.ings || []).forEach(i => { rows += normalRow(i); });
    let instr = instrBlock(subD.en, subD.de);
    (job.ings || []).forEach(i => { if (i.manuf && !READY_MADE.test(i.name) && !/yielded/i.test(i.name) && cache[i.id] && (cache[i.id].en || cache[i.id].de)) { const c = cache[i.id]; const isBrine = /brine|brined/i.test(i.name); const hdr = isBrine ? `🧂 BRINE — ${esc(i.name)}` : `↳ ${esc(i.name)} — sub-recipe`; instr += `<div class="nestInstr${isBrine ? ' brineBox' : ''}"><div class=nih>${hdr}</div>${instrBlock(c.en, c.de)}</div>`; } });
    body = tableWrap(rows) + instr;
  }

  const ctx = `<div class=ctx><b>${esc(job.recName || job.rec)}</b> · target ${job.target} portions · REWORK · Tuesday 04.08.2026 · Shift 2</div>`;
  const cm = `<div class=cm><span><b>Cooking:</b> ${esc(cook.join(', ') || '—')}</span><span><b>Batches:</b> ${batch}</span><span><b>Portion:</b> ${job.pA ?? ''} ${esc(job.pU || '')}${job.scoop ? ' · scoop ' + esc(job.scoop) : ''}</span></div>`;
  return `<div class=page><div class="card${rti ? ' rtiCard' : ''}">${ctx}<div class=ch><span class=sn>${esc(job.sub)}</span><span class=wo>WO ${esc(job.wo)}</span></div>${algBox((job.alg || {}).c)}
    ${cm}
    ${body}</div></div>`;
}

const cards = jobs.map(buildCard).join('');
const html = `<!doctype html><html><head><meta charset=utf-8><style>
@page{size:A4;margin:9mm}*{box-sizing:border-box}body{font-family:Arial,sans-serif;color:#1a1a1a;margin:0;font-size:14px}
.page{page-break-after:always;page-break-before:always}.page:first-child{page-break-before:auto}.page:last-child{page-break-after:auto}.ctx{font-size:14px;color:#555;margin-bottom:5px}.ctx b{color:#2e7d32}
.card{border:1px solid #cfe0cf;border-radius:6px}.rtiCard{border-color:#e0a94f}
table.ing thead{display:table-header-group}tr{page-break-inside:avoid}.instr,.nestInstr{page-break-inside:avoid}
.ch{background:#2e7d32;color:#fff;padding:6px 10px;display:flex;justify-content:space-between;border-radius:5px 5px 0 0}.rtiCard .ch{background:#c77d17}.sn{font-weight:700;font-size:19px}.wo{font-weight:700;background:#fff;color:#2e7d32;padding:2px 10px;border-radius:10px;font-size:16px}.rtiCard .wo{color:#c77d17}
.algBox{padding:5px 10px;background:#fff8f6;border-bottom:1px solid #f0d8d0}.algRow{display:flex;flex-wrap:wrap;gap:5px;align-items:center;margin:1px 0}
.algLc{font-weight:900;color:#c62828;font-size:13px;text-decoration:underline;text-decoration-color:#c62828;text-decoration-thickness:2px;text-underline-offset:2px;letter-spacing:.3px}
.badC{background:#c62828;color:#fff;font-weight:800;font-size:12px;padding:2px 8px;border-radius:9px;border:2px solid #7a0000;text-decoration:underline;text-decoration-thickness:1.5px;text-underline-offset:2px}
.cm{display:flex;flex-wrap:wrap;gap:12px;padding:5px 10px;background:#f4f8f4;font-size:14px;border-bottom:1px solid #e0e0e0}.cm b{color:#2e7d32}.rti{color:#c77d17;font-weight:700}
table.ing{width:100%;border-collapse:collapse}table.ing th{background:#eef4ee;text-align:left;padding:3px 10px;font-size:12px;text-transform:uppercase;color:#555}table.ing td{padding:3px 10px;border-bottom:1px solid #eee;font-size:14px}.r{text-align:right;white-space:nowrap}
tr.mf td{font-weight:600}.tag{font-size:11px;color:#c77d17;background:#fdf3e6;padding:0 4px;border-radius:8px}.rdy{font-size:11px;color:#2e7d32;background:#eef4ee;padding:0 4px;border-radius:8px}tr.nest td{background:#fafcfa;color:#555;font-size:13px;padding-left:22px}
table.ing tr.spice td{border-bottom:2px solid #c77d17}.sep{font-size:11px;font-weight:700;color:#b23c17;background:#fde8e0;padding:0 4px;border-radius:8px}
.instr{display:flex;gap:10px;padding:6px 10px;background:#fbfdfb;border-top:1px solid #e0e0e0}.ic{flex:1;font-size:13px;line-height:1.3}.ih{font-weight:700;color:#2e7d32;font-size:13px}.setup{background:#fff3b0;font-weight:700;padding:0 3px;border-radius:3px}
.nestInstr{border-top:1px dashed #cfe0cf;background:#fdf9f2}.nih{padding:3px 10px 0;font-weight:700;color:#c77d17;font-size:13px}
.brineTag{font-size:11px;color:#1565c0;background:#e3f0fb;padding:0 4px;border-radius:8px}.brineBox{border-top:1px dashed #90caf9;background:#f2f8fe}.brineBox .nih{color:#1565c0}
.secH{padding:6px 10px;font-weight:800;font-size:15px;border-top:2px solid #e0e0e0}.secH.brine{background:#e3f0fb;color:#1565c0}.secH.mar{background:#eef4ee;color:#2e7d32}</style></head><body>${cards}</body></html>`;

fs.writeFileSync(OUT, html, 'utf8');
console.log('HTML written:', OUT, '| bytes', html.length, '| cards', jobs.length);
