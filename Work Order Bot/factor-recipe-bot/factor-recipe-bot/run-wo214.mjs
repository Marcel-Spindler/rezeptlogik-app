// run-wo214.mjs — build PDF for WO 34-214 (Courgette Bolognese, Friday 14.08.2026)
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { isSpiceRoom, isSeparate, READY_MADE } from './capacity-rules.js';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log(new Date().toISOString(), ...a);

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SCRATCHPAD = String.raw`C:\Users\MATTEO~1\AppData\Local\Temp\claude\C--Users-MatteoSpessotto-Desktop-Aiuto-Claude\ef468754-858a-4d55-8783-b7a90ff60ff4\scratchpad`;
const OUT_DIR = 'G:\\Shared drives\\Recipe  Bible';
const STATE_FILE = path.join(__dir, 'generated-wos.json');
const TODAY = '2026-08-14';

function esc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m])); }
function fmt(t) { return esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/"([^"]{1,60}?)"/g, '"<span class=setup>$1</span>"').replace(/\n+/g, '<br>'); }
function q(g) { return (g == null || isNaN(g)) ? '—' : (g < 1000 ? Math.round(g) + ' g' : (g/1000).toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' kg'); }
function nm(n) { return `${esc(n)}${isSeparate(n) ? ' <span class=sep>SEPARATE</span>' : ''}`; }
function qc(n, g) { return `<td class="r">${q(g)}</td>`; }
function rowCls(...cls) { return cls.filter(Boolean).join(' '); }
function spiceFirst(arr) { return [...arr].sort((a,b) => (isSpiceRoom(b.name)?1:0)-(isSpiceRoom(a.name)?1:0)); }
function instrBlock(en, de, label) {
  if (!en && !de) return '';
  return `<div class=instr><div class=ic><div class=ih>${label ? label+' — ' : ''}INSTRUCTIONS (EN)</div>${fmt(en)||'—'}</div><div class=ic><div class=ih>${label ? label+' — ' : ''}ANLEITUNG (DE)</div>${fmt(de)||'—'}</div></div>`;
}
function algBox(a) {
  const c = a?.c || [];
  if (!c.length) return '';
  return `<div class=algBox><div class=algRow><span class=algLc>⚠ CONTAINS</span>${c.map(x=>`<span class=badC>${esc(x)}</span>`).join('')}</div></div>`;
}
function tableWrap(r) { return `<table class=ing><thead><tr><th>Ingredient</th><th class=r>Per batch</th><th class=r>Total</th></tr></thead><tbody>${r}</tbody></table>`; }

function buildCard(rec, s, cache, runLabel) {
  const B = s.batchCount || 1;
  const bq = s.batchQuantity != null ? Math.ceil(s.batchQuantity) : null;
  const batch = s.rti ? '<span class=rti>RTI · Ready to Eat → Plating</span>' : (s.batchCount != null ? `<b>${s.batchCount}</b> × ${bq} kg` : '—');
  const process = (s.paths || []).map(esc).join(' | ') || '—';
  const subD = cache[s.id] || {};
  const ctx = `<div class=ctx><b>${esc(rec.name)}</b> · ${esc(rec.skuCode)} · ${s.totalPortions ?? rec.totalPortions} portions · ${esc(runLabel)}</div>`;
  let rows = '';
  spiceFirst(s.ings || []).forEach(i => {
    const tag = '';
    rows += `<tr class="${rowCls(isSpiceRoom(i.name), '')}"><td>${nm(i.name)}${tag}</td>${qc(i.name, i.g != null ? i.g / B : null)}${qc(i.name, i.g)}</tr>`;
  });
  const instr = instrBlock(subD.en, subD.de);
  const body = tableWrap(rows) + instr;
  return `<div class=page><div class="card${s.rti ? ' rtiCard' : ''}">${ctx}<div class=ch><span class=sn>${esc(s.name)}</span><span class=wo>WO ${esc(s.wo||'-')}</span></div>${algBox(s.alg)}
    <div class=cm><span><b>Cooking:</b> ${esc((s.cook||[]).join(', ')||'—')}</span><span><b>Process:</b> ${process}</span><span><b>Batches:</b> ${batch}</span><span><b>Portion:</b> ${s.portionA ?? ''} ${esc(s.portionU||'')}${s.scoop ? ' · scoop ' + esc(s.scoop) : ''}</span></div>
    ${body}</div></div>`;
}

function wrapDocument(allCards) {
  return `<!doctype html><html><head><meta charset=utf-8><style>
  @page{size:A4;margin:9mm}*{box-sizing:border-box}body{font-family:Arial,sans-serif;color:#1a1a1a;margin:0;font-size:14px}
  .page{page-break-after:always;page-break-before:always}.page:first-child{page-break-before:auto}.page:last-child{page-break-after:auto}.ctx{font-size:14px;color:#555;margin-bottom:5px}.ctx b{color:#2e7d32}
  .card{border:1px solid #cfe0cf;border-radius:6px}.rtiCard{border-color:#e0a94f}
  table.ing thead{display:table-header-group}tr{page-break-inside:avoid}.instr{page-break-inside:avoid}
  .ch{background:#2e7d32;color:#fff;padding:6px 10px;display:flex;justify-content:space-between;border-radius:5px 5px 0 0}.sn{font-weight:700;font-size:19px}.wo{font-weight:700;background:#fff;color:#2e7d32;padding:2px 10px;border-radius:10px;font-size:16px}
  .algBox{padding:5px 10px;background:#fff8f6;border-bottom:1px solid #f0d8d0}.algRow{display:flex;flex-wrap:wrap;gap:5px;align-items:center;margin:1px 0}
  .algLc{font-weight:900;color:#c62828;font-size:13px;text-decoration:underline;text-decoration-color:#c62828;text-decoration-thickness:2px;text-underline-offset:2px;letter-spacing:.3px}
  .badC{background:#c62828;color:#fff;font-weight:800;font-size:12px;padding:2px 8px;border-radius:9px;border:2px solid #7a0000;text-decoration:underline;text-decoration-thickness:1.5px;text-underline-offset:2px}
  .cm{display:flex;flex-wrap:wrap;gap:12px;padding:5px 10px;background:#f4f8f4;font-size:14px;border-bottom:1px solid #e0e0e0}.cm b{color:#2e7d32}.rti{color:#c77d17;font-weight:700}
  table.ing{width:100%;border-collapse:collapse}table.ing th{background:#eef4ee;text-align:left;padding:3px 10px;font-size:12px;text-transform:uppercase;color:#555}table.ing td{padding:3px 10px;border-bottom:1px solid #eee;font-size:14px}.r{text-align:right;white-space:nowrap}
  tr.mf td{font-weight:600}.sep{font-size:11px;font-weight:700;color:#b23c17;background:#fde8e0;padding:0 4px;border-radius:8px}
  .instr{display:flex;gap:10px;padding:6px 10px;background:#fbfdfb;border-top:1px solid #e0e0e0}.ic{flex:1;font-size:13px;line-height:1.3}.ih{font-weight:700;color:#2e7d32;font-size:13px}.setup{background:#fff3b0;font-weight:700;padding:0 3px;border-radius:3px}
  table.ing tr.spice td{border-bottom:2px solid #c77d17}</style></head><body>${allCards}
  <script>(function(){var T=1030,M=0.55;document.querySelectorAll('.card').forEach(function(c){var h=c.getBoundingClientRect().height;if(h>T){var z=Math.max(M,T/h);c.style.zoom=z;}});})();</script></body></html>`;
}

// ---- Main ----
const gathered = JSON.parse(fs.readFileSync(path.join(__dir, 'gathered-wo214.json'), 'utf8'));
log('Loaded', gathered.length, 'group(s)');

const now = new Date();
const hhmm = String(now.getHours()).padStart(2,'0') + String(now.getMinutes()).padStart(2,'0');
const kwDir = path.join(OUT_DIR, 'KW 34');
const pdfName = `KW34 Friday 14.08.2026 ${hhmm}.pdf`;
const htmlPath = path.join(SCRATCHPAD, 'wo214.html');
const pdfPath = path.join(kwDir, pdfName);

let allCards = '';
for (const g of gathered) {
  log(`Building: ${g.recName} Run ${g.runN} WOs=${g.newWOs.join(',')}`);
  for (const s of (g.subs || [])) {
    allCards += buildCard(g.rec, s, g.cache, `RUN ${g.runN}`);
  }
}

const html = wrapDocument(allCards);
fs.writeFileSync(htmlPath, html, 'utf8');
log('HTML written:', htmlPath, html.length, 'chars');

const fileUrl = 'file:///' + htmlPath.replace(/\\/g, '/').replace(/ /g, '%20');
const cmd = `"${CHROME}" --headless=new --disable-gpu --no-pdf-header-footer --print-to-pdf="${pdfPath}" "${fileUrl}"`;
log('Running Chrome...');
execSync(cmd, { stdio: 'pipe', timeout: 60000 });

if (!fs.existsSync(pdfPath)) { log('ERROR: PDF not created!'); process.exit(1); }
log('PDF saved:', pdfPath, fs.statSync(pdfPath).size, 'bytes');

// Update state
const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
state.doneWO['34-214'] = TODAY;
state.runCount['REC-014094-4-002'] = 9;
fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
log('generated-wos.json updated');
try { fs.unlinkSync(htmlPath); } catch {}
log('Done. PDF:', pdfName);
