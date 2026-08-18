// run-aug13-1300.mjs — reads factor-gathered (1).json from Downloads,
// builds one combined HTML with all new WO cards, prints PDF via Chrome headless,
// updates generated-wos.json.
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { isSpiceRoom, isSeparate, READY_MADE } from './capacity-rules.js';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log(new Date().toISOString(), ...a);

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SCRATCHPAD = String.raw`C:\Users\MATTEO~1\AppData\Local\Temp\claude\C--Users-MatteoSpessotto-Desktop-Aiuto-Claude\ef468754-858a-4d55-8783-b7a90ff60ff4\scratchpad`;
const DOWNLOADS = 'C:\\Users\\MatteoSpessotto\\Downloads';
const OUT_DIR = process.env.FACTOR_OUT || 'G:\\Shared drives\\Recipe  Bible';
const STATE_FILE = path.join(__dir, 'generated-wos.json');
const TODAY = '2026-08-13';

// ---- buildHtml (same logic as bot.mjs / build-html.mjs, with per-sub totalPortions) ----
function cardsHtml(rec, subs, cache, runLabel) {
  const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
  const fmt = t => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/"([^"]{1,60}?)"/g, '"<span class=setup>$1</span>"').replace(/\n+/g, '<br>');
  const q = g => (g == null || isNaN(g)) ? '—' : (g < 1000 ? Math.round(g) + ' g' : (g/1000).toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' kg');
  const nm = n => `${esc(n)}${isSeparate(n) ? ' <span class=sep>SEPARATE</span>' : ''}`;
  const qc = (n, g) => `<td class="r">${q(g)}</td>`;
  const rowCls = (spice, ...extra) => [...extra, spice ? 'spice' : ''].filter(Boolean).join(' ');
  // Per-sub ctx (shows correct portions for each sub, esp. when variants have different targets)
  const ctx = s => `<div class=ctx><b>${esc(rec.name)}</b> · ${esc(rec.skuCode)} · ${s.totalPortions ?? rec.totalPortions} portions · ${esc(runLabel)}</div>`;
  const algBox = a => { const c = a?.c || []; if (!c.length) return ''; return `<div class=algBox><div class=algRow><span class=algLc>⚠ CONTAINS</span>${c.map(x => `<span class=badC>${esc(x)}</span>`).join('')}</div></div>`; };
  const tableWrap = r => `<table class=ing><thead><tr><th>Ingredient</th><th class=r>Per batch</th><th class=r>Total</th></tr></thead><tbody>${r}</tbody></table>`;
  const instrBlock = (en, de, label) => (en || de) ? `<div class=instr><div class=ic><div class=ih>${label ? label + ' — ' : ''}INSTRUCTIONS (EN)</div>${fmt(en) || '—'}</div><div class=ic><div class=ih>${label ? label + ' — ' : ''}ANLEITUNG (DE)</div>${fmt(de) || '—'}</div></div>` : '';
  const nmSalt = n => { const salt = /salt|salz/i.test(n); return `${esc(n)}${isSeparate(n) || salt ? ' <span class=sep>SEPARATE</span>' : ''}`; };
  const spiceFirst = (arr, saltAlso) => [...arr].sort((a, b) => {
    const sa = (isSpiceRoom(a.name) || (saltAlso && /salt|salz/i.test(a.name))) ? 1 : 0;
    const sb = (isSpiceRoom(b.name) || (saltAlso && /salt|salz/i.test(b.name))) ? 1 : 0;
    return sb - sa;
  });
  const expand = (children, depth) => {
    let out = '';
    spiceFirst(children || []).forEach(x => {
      const ready = READY_MADE.test(x.name);
      const deeper = !ready && x.manuf && (x.children || []).length && depth < 5;
      const tag = ready ? ' <span class=rdy>ready · weekly prep</span>' : (deeper ? ' <span class=tag>sub ↓</span>' : '');
      out += `<tr class="${rowCls(isSpiceRoom(x.name), 'nest')}"><td style="padding-left:${10 + depth * 14}px">↳ ${nm(x.name)}${tag}</td>${qc(x.name, x.g / (subs[0]?.batchCount || 1))}${qc(x.name, x.g)}</tr>`;
      if (deeper) out += expand(x.children, depth + 1);
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
    const expandS = (children, depth) => {
      let out = '';
      spiceFirst(children || []).forEach(x => {
        const ready = READY_MADE.test(x.name);
        const deeper = !ready && x.manuf && (x.children || []).length && depth < 5;
        const tag = ready ? ' <span class=rdy>ready · weekly prep</span>' : (deeper ? ' <span class=tag>sub ↓</span>' : '');
        out += `<tr class="${rowCls(isSpiceRoom(x.name), 'nest')}"><td style="padding-left:${10 + depth * 14}px">↳ ${nm(x.name)}${tag}</td>${qc(x.name, x.g / B)}${qc(x.name, x.g)}</tr>`;
        if (deeper) out += expandS(x.children, depth + 1);
      });
      return out;
    };
    const normalRow = i => {
      const ready = i.manuf && READY_MADE.test(i.name);
      const noExp = i.manuf && /yielded/i.test(i.name);
      const isBrine = i.manuf && /brine|brined/i.test(i.name);
      const tag = !i.manuf ? '' : ready ? ' <span class=rdy>ready · weekly prep</span>' : noExp ? '' : isBrine ? ' <span class=brineTag>BRINE ↓</span>' : ' <span class=tag>sub-recipe ↓</span>';
      let out = `<tr class="${rowCls(isSpiceRoom(i.name), i.manuf && !noExp ? 'mf' : '')}"><td>${nm(i.name)}${tag}</td>${qc(i.name, i.g != null ? i.g / B : null)}${qc(i.name, i.g)}</tr>`;
      if (i.manuf && !ready && !noExp && (i.children || []).length) out += expandS(i.children, 1);
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
    return `<div class=page><div class="card${s.rti ? ' rtiCard' : ''}">${ctx(s)}<div class=ch><span class=sn>${esc(s.name)}</span><span class=wo>WO ${esc(s.wo || '-')}</span></div>${algBox(A)}
      <div class=cm><span><b>Cooking:</b> ${esc((s.cook || []).join(', ') || '—')}</span><span><b>Process:</b> ${process}</span><span><b>Batches:</b> ${batch}</span><span><b>Portion:</b> ${s.portionA ?? ''} ${esc(s.portionU || '')}${s.scoop ? ' · scoop ' + esc(s.scoop) : ''}</span></div>
      ${body}</div></div>`;
  }).join('');
  return cards;
}

function wrapDocument(allCards) {
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
  .secH{padding:6px 10px;font-weight:800;font-size:15px;border-top:2px solid #e0e0e0}.secH.brine{background:#e3f0fb;color:#1565c0}.secH.mar{background:#eef4ee;color:#2e7d32}</style></head><body>${allCards}
  <script>
  (function(){var T=1030,M=0.55;document.querySelectorAll('.card').forEach(function(c){var h=c.getBoundingClientRect().height;if(h>T){var z=Math.max(M,T/h);c.style.zoom=z;}});})();
  </script></body></html>`;
}

// ---- Main ----
const dataFile = path.join(DOWNLOADS, 'factor-gathered (1).json');
if (!fs.existsSync(dataFile)) { log('ERROR: gathered data not found at', dataFile); process.exit(1); }
const gathered = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
log(`Loaded ${gathered.length} groups from gathered data`);

// PDF naming: KW34 Thursday 13.08.2026 HHMM.pdf
const now = new Date();
const hhmm = String(now.getHours()).padStart(2,'0') + String(now.getMinutes()).padStart(2,'0');
const kwDir = path.join(OUT_DIR, 'KW 34');
if (!fs.existsSync(kwDir)) { fs.mkdirSync(kwDir, { recursive: true }); log('Created KW folder:', kwDir); }

const pdfName = `KW34 Thursday 13.08.2026 ${hhmm}.pdf`;
const htmlPath = path.join(SCRATCHPAD, 'combined-aug13.html');
const pdfPath = path.join(kwDir, pdfName);

// Build all cards combined
let allCards = '';
const summaryLines = [];
for (const g of gathered) {
  if (!g.subs || !g.subs.length) { log(`SKIP (no subs): ${g.recId}`); continue; }
  log(`Building cards: ${g.recName} Run ${g.runN} (${g.subs.length} cards, WOs: ${g.newWOs.join(', ')})`);
  allCards += cardsHtml(g.rec, g.subs, g.cache, `RUN ${g.runN}`);
  summaryLines.push(`Run ${g.runN}: ${g.recName} — WOs ${g.newWOs.join(', ')}`);
}

if (!allCards) { log('No cards to render — nothing to do.'); process.exit(0); }

const html = wrapDocument(allCards);
fs.writeFileSync(htmlPath, html, 'utf8');
log(`HTML written: ${htmlPath} (${html.length} chars)`);

// Run Chrome headless to print PDF
const fileUrl = 'file:///' + htmlPath.replace(/\\/g, '/').replace(/ /g, '%20');
const chromeCmd = `"${CHROME}" --headless=new --disable-gpu --no-pdf-header-footer --user-data-dir="${path.join(SCRATCHPAD, 'chrome-tmp')}" --print-to-pdf="${pdfPath}" "${fileUrl}"`;
log('Running Chrome headless...');
try {
  execSync(chromeCmd, { stdio: 'pipe', timeout: 60000 });
  log(`PDF saved: ${pdfPath}`);
} catch (e) {
  log('Chrome error:', e.message);
  // Try without user-data-dir
  const cmd2 = `"${CHROME}" --headless=new --disable-gpu --no-pdf-header-footer --print-to-pdf="${pdfPath}" "${fileUrl}"`;
  execSync(cmd2, { stdio: 'pipe', timeout: 60000 });
  log(`PDF saved (retry): ${pdfPath}`);
}

// Verify PDF exists
if (!fs.existsSync(pdfPath)) { log('ERROR: PDF not created!'); process.exit(1); }
const pdfSize = fs.statSync(pdfPath).size;
log(`PDF verified: ${pdfSize} bytes`);

// Update generated-wos.json
const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
for (const g of gathered) {
  if (!g.subs || !g.subs.length) continue;
  g.newWOs.forEach(w => { state.doneWO[w] = TODAY; });
  state.runCount[g.recId] = g.runN;
}
fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
log('generated-wos.json updated');

// Cleanup
try { fs.unlinkSync(htmlPath); } catch {}

log('\n=== SUMMARY ===');
log(`PDF: ${pdfName}`);
log(`Path: ${pdfPath}`);
log(`Total WOs: ${gathered.flatMap(g => g.newWOs).length}`);
summaryLines.forEach(l => log(' ', l));
