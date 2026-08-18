// Fix for FV0485A Run8 / FV4053A Run4 (Wed 05.08 Shift2 rework): the ctx header line was stuck on one
// target-portions value across all pages of the same recipe, even though each sub-recipe in these partial
// reworks has its OWN distinct target (verified against live ET + re-gathered API data — all ingredient
// quantities were already correct, only the displayed header number was wrong). Rebuilds both PDFs with
// the correct per-page target in the ctx line.
import fs from 'fs';
import { execSync } from 'child_process';
import { classify, isSpiceRoom, isSeparate, READY_MADE } from './capacity-rules.js';

const data = JSON.parse(fs.readFileSync('C:/Users/MatteoSpessotto/Downloads/fix-w33-wed-shift2.json', 'utf8'));
const jobs = data.jobs;
const cache = data.cache;
const paths = JSON.parse(fs.readFileSync('C:/Users/MatteoSpessotto/Downloads/fix-w33-paths.json', 'utf8'));

const RUN_LABEL = { 'REC-013537-4-007': 8, 'REC-013455-4-002': 4 };
const OUT_NAME = {
  'REC-013537-4-007': 'FV0485A - Rosemary-tomato chicken - [DE] - Run 8.pdf',
  'REC-013455-4-002': 'FV4053A - Gochugaru Chicken [DE] - Run 4.pdf',
};

const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
const fmt = t => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/"([^"]{1,60}?)"/g, '"<span class=setup>$1</span>"').replace(/\n+/g, '<br>');
const q = g => (g == null || isNaN(g)) ? '—' : (g < 1000 ? Math.round(g) + ' g' : (g / 1000).toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' kg');
const nm = n => `${esc(n)}${isSeparate(n) ? ' <span class=sep>SEPARATE</span>' : ''}`;
const qc = (n, g) => `<td class="r">${q(g)}</td>`;
const rowCls = (spice, ...extra) => [...extra, spice ? 'spice' : ''].filter(Boolean).join(' ');
const algBox = c => { if (!c || !c.length) return ''; return `<div class=algBox><div class=algRow><span class=algLc>⚠ CONTAINS</span>${c.map(x => `<span class=badC>${esc(x)}</span>`).join('')}</div></div>`; };
const tableWrap = r => `<table class=ing><thead><tr><th>Ingredient</th><th class=r>Per batch</th><th class=r>Total</th></tr></thead><tbody>${r}</tbody></table>`;
const instrBlock = (en, de, label) => (en || de) ? `<div class=instr><div class=ic><div class=ih>${label ? label + ' — ' : ''}INSTRUCTIONS (EN)</div>${fmt(en) || '—'}</div><div class=ic><div class=ih>${label ? label + ' — ' : ''}ANLEITUNG (DE)</div>${fmt(de) || '—'}</div></div>` : '';
const nmSalt = n => `${esc(n)}${isSeparate(n) ? ' <span class=sep>SEPARATE</span>' : ''}`;
const spiceFirst = (arr) => [...(arr || [])].sort((a, b) => (isSpiceRoom(b.name) ? 1 : 0) - (isSpiceRoom(a.name) ? 1 : 0));

function buildCard(job) {
  const cook = job.cook || [];
  const cls = classify(job.sub, cook);
  const rti = job.rti || cls.rti;
  const B = job.batchCount || 1;
  const bq = job.batchQuantity != null ? Math.ceil(job.batchQuantity) : null;
  const batch = rti ? '<span class=rti>RTI · portion only → Plating</span>' : (job.batchCount != null ? `<b>${job.batchCount}</b> × ${bq} kg` : '—');
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
    if (rti) rows = `<tr class="${rowCls(isSpiceRoom(job.sub), 'mf')}"><td>${nm(job.sub)}</td>${qc(job.sub, null)}${qc(job.sub, null)}</tr>`;
    else spiceFirst(job.ings || []).forEach(i => { rows += normalRow(i); });
    let instr = instrBlock(subD.en, subD.de);
    (job.ings || []).forEach(i => { if (i.manuf && !READY_MADE.test(i.name) && !/yielded/i.test(i.name) && cache[i.id] && (cache[i.id].en || cache[i.id].de)) { const c = cache[i.id]; const isBrine = /brine|brined/i.test(i.name); const hdr = isBrine ? `🧂 BRINE — ${esc(i.name)}` : `↳ ${esc(i.name)} — sub-recipe`; instr += `<div class="nestInstr${isBrine ? ' brineBox' : ''}"><div class=nih>${hdr}</div>${instrBlock(c.en, c.de)}</div>`; } });
    body = tableWrap(rows) + instr;
  }

  // FIX: target portions per-page (job.target), not a single value shared across the whole recipe's pages
  const ctx = `<div class=ctx><b>${esc(job.recName)}</b> · ${esc(job.rec)} · ${job.target} portions · RUN ${RUN_LABEL[job.rec]}</div>`;
  const proc = (paths[job.wo] || []).join(' | ') || '—';
  const cm = `<div class=cm><span><b>Cooking:</b> ${esc(cook.join(', ') || '—')}</span><span><b>Process:</b> ${esc(proc)}</span><span><b>Batches:</b> ${batch}</span><span><b>Portion:</b> ${job.portionA ?? ''} ${esc(job.portionU || '')}${job.scoop ? ' · scoop ' + esc(job.scoop) : ''}</span></div>`;
  return `<div class=page><div class="card${rti ? ' rtiCard' : ''}">${ctx}<div class=ch><span class=sn>${esc(job.sub)}</span><span class=wo>WO ${esc(job.wo)}</span></div>${algBox((job.alg || {}).c)}
    ${cm}
    ${body}</div></div>`;
}

const STYLE = `<style>
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
.secH{padding:6px 10px;font-weight:800;font-size:15px;border-top:2px solid #e0e0e0}.secH.brine{background:#e3f0fb;color:#1565c0}.secH.mar{background:#eef4ee;color:#2e7d32}</style>`;

const byRec = {};
for (const j of jobs) { (byRec[j.rec] = byRec[j.rec] || []).push(j); }

const tmpDir = 'C:/Users/MatteoSpessotto/Desktop/Aiuto Claude/factor-recipe-bot/temp-html';
fs.mkdirSync(tmpDir, { recursive: true });
const outDir = 'G:/Shared drives/Recipe  Bible';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

for (const [rec, recJobs] of Object.entries(byRec)) {
  const cards = recJobs.map(buildCard).join('');
  const html = `<!doctype html><html><head><meta charset=utf-8>${STYLE}</head><body>${cards}</body></html>`;
  const base = OUT_NAME[rec].replace(/\.pdf$/, '');
  const htmlPath = `${tmpDir}/${base}.html`;
  fs.writeFileSync(htmlPath, html, 'utf8');
  const winPath = execSync(`cygpath -m "${htmlPath}"`).toString().trim();
  const outPdf = `${outDir}/${OUT_NAME[rec]}`;
  const profileDir = `${tmpDir}/chrome-fix-profile`;
  execSync(`"${CHROME}" --headless=new --disable-gpu --no-pdf-header-footer --user-data-dir="${execSync(`cygpath -m "${profileDir}"`).toString().trim()}" --print-to-pdf="${outPdf}" "file:///${winPath}"`, { stdio: 'inherit' });
  const size = fs.statSync(outPdf).size;
  console.log('Wrote', outPdf, size, 'bytes,', recJobs.length, 'pages');
}
