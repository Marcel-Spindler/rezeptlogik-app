// run-w34-aug7.mjs — W34 combined PDFs (Mon 10.8 / Tue 11.8 / Wed 12.8)
// Reads pre-gathered data from Downloads/w34-gathered.json (no token required)
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { isSeparate, isSpiceRoom, READY_MADE } from './capacity-rules.js';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log(new Date().toISOString(), ...a);
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SCRATCH = String.raw`C:\Users\MATTEO~1\AppData\Local\Temp\claude\C--Users-MatteoSpessotto-Desktop-Aiuto-Claude\e2d17484-cba4-462a-b4dc-360d8b21d8a6\scratchpad`;
const GATHERED = String.raw`C:\Users\MatteoSpessotto\Downloads\w34-gathered.json`;
const STATE_FILE = path.join(__dir, 'generated-wos.json');
const OUT_BASE = process.env.FACTOR_OUT || 'G:\\Shared drives\\Recipe  Bible';

// WO numbers per recipe — used to update state file after PDF generation
const RECIPE_WOS = {
  'REC-013918-4-004': ['34-62','34-63','34-64','34-65','34-66','34-67'],
  'REC-014155-4-004': ['34-57','34-58','34-59','34-60','34-61'],
  'REC-014094-4-002': ['34-11','34-12','34-13','34-14','34-15'],
  'REC-014063-4-004': ['34-112','34-113','34-114','34-115','34-116'],
  'REC-013401-4-001': ['34-134','34-135','34-136','34-137','34-138','34-139'],
  'REC-013994-4-004': ['34-98','34-100','34-101','34-164'],
  'REC-013554-4-003': ['34-1','34-2','34-3','34-4','34-5'],
  'REC-022729-4-005': ['34-122','34-124','34-125','34-126','34-127','34-165'],
  'REC-013819-4-002': ['34-86','34-87','34-88','34-89','34-90','34-91'],
  'REC-013423-4-003': ['34-76','34-77','34-78','34-79','34-80'],
  'REC-014315-4-006': ['34-156','34-157','34-158','34-159'],
  'REC-013489-4-001': ['34-41','34-42','34-43','34-44'],
  'REC-029409-4-003': ['34-68','34-69','34-70','34-71'],
  'REC-014288-4-002': ['34-49','34-50','34-51','34-52'],
  'REC-013946-4-002': ['34-106','34-107','34-108'],
  'REC-013940-4-006': ['34-31','34-32','34-33','34-34','34-35'],
  'REC-029892-4-001': ['34-146','34-147','34-148','34-149','34-150'],
  'REC-013579-4-001': ['34-21','34-22','34-23','34-24','34-25'],
};

// ---- buildCards (returns inner card HTML per recipe) ----
function buildCards(rec, subs, cache, runLabel) {
  const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
  const fmt = t => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/"([^"]{1,60}?)"/g, '"<span class=setup>$1</span>"').replace(/\n+/g, '<br>');
  const q = g => (g == null || isNaN(g)) ? '—' : (g < 1000 ? Math.round(g) + ' g' : (g / 1000).toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' kg');
  const nm = n => `${esc(n)}${isSeparate(n) ? ' <span class=sep>SEPARATE</span>' : ''}`;
  const qc = (n, g) => `<td class="r">${q(g)}</td>`;
  const rowCls = (spice, ...extra) => [...extra, spice ? 'spice' : ''].filter(Boolean).join(' ');
  const ctx = `<div class=ctx><b>${esc(rec.name)}</b> · ${esc(rec.skuCode)} · ${rec.totalPortions} portions · ${esc(runLabel)}</div>`;
  const algBox = a => { const c = a?.c || []; if (!c.length) return ''; return `<div class=algBox><div class=algRow><span class=algLc>⚠ CONTAINS</span>${c.map(x => `<span class=badC>${esc(x)}</span>`).join('')}</div></div>`; };
  const tableWrap = r => `<table class=ing><thead><tr><th>Ingredient</th><th class=r>Per batch</th><th class=r>Total</th></tr></thead><tbody>${r}</tbody></table>`;
  const instrBlock = (en, de, label) => (en || de) ? `<div class=instr><div class=ic><div class=ih>${label ? label + ' — ' : ''}INSTRUCTIONS (EN)</div>${fmt(en) || '—'}</div><div class=ic><div class=ih>${label ? label + ' — ' : ''}ANLEITUNG (DE)</div>${fmt(de) || '—'}</div></div>` : '';
  const nmSalt = n => { const salt = /salt|salz/i.test(n); return `${esc(n)}${isSeparate(n) || salt ? ' <span class=sep>SEPARATE</span>' : ''}`; };
  const spiceFirst = (arr, saltAlso) => [...arr].sort((a, b) => {
    const sa = (isSpiceRoom(a.name) || (saltAlso && /salt|salz/i.test(a.name))) ? 1 : 0;
    const sb = (isSpiceRoom(b.name) || (saltAlso && /salt|salz/i.test(b.name))) ? 1 : 0;
    return sb - sa;
  });
  const expandS = (children, depth, B) => {
    let out = '';
    spiceFirst(children || []).forEach(x => {
      const ready = READY_MADE.test(x.name);
      const deeper = !ready && x.manuf && (x.children || []).length && depth < 5;
      const tag = ready ? ' <span class=rdy>ready · weekly prep</span>' : (deeper ? ' <span class=tag>sub ↓</span>' : '');
      out += `<tr class="${rowCls(isSpiceRoom(x.name), 'nest')}"><td style="padding-left:${10 + depth * 14}px">↳ ${nm(x.name)}${tag}</td>${qc(x.name, x.g / B)}${qc(x.name, x.g)}</tr>`;
      if (deeper) out += expandS(x.children, depth + 1, B);
    });
    return out;
  };
  const cards = subs.map(s => {
    const B = s.batchCount || 1;
    const bq = s.batchQuantity != null ? Math.ceil(s.batchQuantity) : null;
    const batch = s.rti ? '<span class=rti>RTI · Ready to Eat → Plating</span>' : (s.batchCount != null ? `<b>${s.batchCount}</b> × ${bq} kg` : '—');
    const process = (s.paths || []).map(esc).join(' | ') || '—';
    const A = s.alg;
    const subD = cache[s.id] || {};
    const isMar = /marinad|marinat|mariniert/i.test((subD.en || '') + (subD.de || ''));
    const normalRow = i => {
      const ready = i.manuf && READY_MADE.test(i.name);
      const noExp = i.manuf && /yielded/i.test(i.name);
      const isBrine = i.manuf && /brine|brined/i.test(i.name);
      const tag = !i.manuf ? '' : ready ? ' <span class=rdy>ready · weekly prep</span>' : noExp ? '' : isBrine ? ' <span class=brineTag>BRINE ↓</span>' : ' <span class=tag>sub-recipe ↓</span>';
      let out = `<tr class="${rowCls(isSpiceRoom(i.name), i.manuf && !noExp ? 'mf' : '')}"><td>${nm(i.name)}${tag}</td>${qc(i.name, i.g != null ? i.g / B : null)}${qc(i.name, i.g)}</tr>`;
      if (i.manuf && !ready && !noExp && (i.children || []).length) out += expandS(i.children, 1, B);
      return out;
    };
    let body;
    const brinedIng = s.rti ? null : (s.ings || []).find(i => i.manuf && /brine|brined/i.test(i.name));
    if (brinedIng && isMar) {
      const nb = brinedIng.children || [];
      const proteinG = nb.filter(x => !/salt|salz|water|wasser/i.test(x.name)).reduce((a, x) => a + (x.g || 0), 0);
      const brineRows = spiceFirst(nb, true).map(x => { const salt = /salt|salz/i.test(x.name); return `<tr class="${rowCls(isSpiceRoom(x.name) || salt, salt ? 'mf' : '')}"><td>${nmSalt(x.name)}</td>${qc(x.name, x.g / B)}${qc(x.name, x.g)}</tr>`; }).join('');
      const brineSection = `<div class="secH brine">🧂 BRINE — ${esc(brinedIng.name)}</div>${tableWrap(brineRows)}${instrBlock((cache[brinedIng.id] || {}).en, (cache[brinedIng.id] || {}).de, 'BRINE')}`;
      let marRows = ''; spiceFirst((s.ings || []).filter(i => i !== brinedIng)).forEach(i => { marRows += normalRow(i); });
      marRows += `<tr class="${rowCls(isSpiceRoom(brinedIng.name), 'mf')}"><td>${nm(brinedIng.name)} <span class=brineTag>↑ from BRINE (raw protein, no water)</span></td>${qc(brinedIng.name, proteinG / B)}${qc(brinedIng.name, proteinG)}</tr>`;
      let marInstrExtra = ''; (s.ings || []).forEach(i => { if (i === brinedIng || !i.manuf || READY_MADE.test(i.name) || /yielded/i.test(i.name) || !cache[i.id] || !(cache[i.id].en || cache[i.id].de)) return; const c = cache[i.id]; marInstrExtra += `<div class=nestInstr><div class=nih>↳ ${esc(i.name)} — sub-recipe</div>${instrBlock(c.en, c.de)}</div>`; });
      const marSection = `<div class="secH mar">MARINADE — ${esc(s.name)}</div>${tableWrap(marRows)}${instrBlock(subD.en, subD.de, 'MARINADE')}${marInstrExtra}`;
      body = brineSection + marSection;
    } else {
      let rows = '';
      if (s.rti) rows = `<tr class="${rowCls(isSpiceRoom(s.name), 'mf')}"><td>${nm(s.name)}</td>${qc(s.name, s.totalNeeded)}${qc(s.name, s.totalNeeded)}</tr>`;
      else spiceFirst(s.ings || []).forEach(i => { rows += normalRow(i); });
      let instr = instrBlock(subD.en, subD.de);
      (s.ings || []).forEach(i => { if (i.manuf && !READY_MADE.test(i.name) && !/yielded/i.test(i.name) && cache[i.id] && (cache[i.id].en || cache[i.id].de)) { const c = cache[i.id]; const isBrine = /brine|brined/i.test(i.name); const hdr = isBrine ? `🧂 BRINE — ${esc(i.name)}` : `↳ ${esc(i.name)} — sub-recipe`; instr += `<div class="nestInstr${isBrine ? ' brineBox' : ''}"><div class=nih>${hdr}</div>${instrBlock(c.en, c.de)}</div>`; } });
      body = tableWrap(rows) + instr;
    }
    return `<div class=page><div class="card${s.rti ? ' rtiCard' : ''}">${ctx}<div class=ch><span class=sn>${esc(s.name)}</span><span class=wo>WO ${esc(s.wo || '-')}</span></div>${algBox(A)}
      <div class=cm><span><b>Cooking:</b> ${esc((s.cook || []).join(', ') || '—')}</span><span><b>Process:</b> ${process}</span><span><b>Batches:</b> ${batch}</span><span><b>Portion:</b> ${s.portionA ?? ''} ${esc(s.portionU || '')}${s.scoop ? ' · scoop ' + esc(s.scoop) : ''}</span></div>
      ${body}</div></div>`;
  }).join('');
  return cards;
}

// ---- wrapDoc (full HTML document for one day's combined PDF) ----
function wrapDoc(cards) {
  return `<!doctype html><html><head><meta charset=utf-8><style>
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
}

// ---- Main ----
log('=== W34 PDF Builder ===');
if (!fs.existsSync(GATHERED)) { log('ERROR: gathered file not found:', GATHERED); process.exit(1); }
const gathered = JSON.parse(fs.readFileSync(GATHERED, 'utf8'));
const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
const outDir = fs.existsSync(OUT_BASE) ? OUT_BASE : SCRATCH;
if (outDir === SCRATCH) log('WARNING: SharedDrive not found, writing to scratchpad');

const dayCards = {};
const dayWOs = {};
const errors = [];

for (const item of gathered) {
  if (item.error) { log('SKIP error:', item.recCode, item.error); errors.push(`${item.recCode}: ${item.error}`); continue; }
  const runN = (state.runCount[item.recCode] || 0) + 1;
  log(`Building ${item.recCode} → RUN ${runN} (${item.subs.length} subs, date=${item.date})`);
  const cards = buildCards(item.rec, item.subs, item.cache, `RUN ${runN}`);
  if (!dayCards[item.date]) { dayCards[item.date] = ''; dayWOs[item.date] = []; }
  dayCards[item.date] += cards;
  const wos = RECIPE_WOS[item.recCode] || [];
  dayWOs[item.date].push(...wos);
  wos.forEach(w => { state.doneWO[w] = item.date; });
  state.runCount[item.recCode] = runN;
}

// Print one PDF per day
const WEEKDAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const now = new Date();
const hhmm = String(now.getHours()).padStart(2,'0') + String(now.getMinutes()).padStart(2,'0');
const generated = [];

for (const [date, cards] of Object.entries(dayCards)) {
  const d = new Date(date + 'T12:00:00');
  const weekday = WEEKDAYS[d.getDay()];
  const dd = String(d.getDate()).padStart(2,'0');
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const yyyy = d.getFullYear();
  const pdfName = `Recipes ${weekday} ${dd}.${mm}.${yyyy} ${hhmm}.pdf`;
  const html = wrapDoc(cards);
  const htmlPath = path.join(SCRATCH, pdfName.replace('.pdf', '.html'));
  const pdfScratch = path.join(SCRATCH, pdfName);
  const pdfFinal = path.join(outDir, pdfName);
  fs.writeFileSync(htmlPath, html, 'utf8');
  const fileUrl = 'file:///' + htmlPath.replace(/\\/g, '/').replace(/ /g, '%20');
  log(`Printing: ${pdfName} (${dayWOs[date].length} WOs)`);
  execSync(`"${CHROME}" --headless=new --disable-gpu --no-pdf-header-footer --print-to-pdf="${pdfScratch}" "${fileUrl}"`, { stdio: 'pipe', timeout: 60000 });
  if (outDir !== SCRATCH) { fs.copyFileSync(pdfScratch, pdfFinal); fs.unlinkSync(pdfScratch); }
  fs.unlinkSync(htmlPath);
  generated.push({ file: pdfName, path: pdfFinal, wos: dayWOs[date] });
  log(`MADE: ${pdfFinal}`);
}

// Persist state
fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
log('=== DONE ===');
log(`Generated ${generated.length} PDFs, ${errors.length} errors`);
if (errors.length) log('Errors:', errors.join('; '));
log('Files:', generated.map(g => g.file).join(', '));
