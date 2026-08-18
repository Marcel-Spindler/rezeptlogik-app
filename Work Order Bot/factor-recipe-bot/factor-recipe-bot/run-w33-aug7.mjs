// run-w33-aug7.mjs — W33 new WOs for Wed 05.08 (33-190) + Fri 07.08 (33-209/210/216/217/218)
// Produces ONE combined PDF per day, all recipes merged.
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { classify, isSpiceRoom, isSeparate, READY_MADE } from './capacity-rules.js';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log(new Date().toISOString(), ...a);
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SCRATCH = String.raw`C:\Users\MATTEO~1\AppData\Local\Temp\claude\C--Users-MatteoSpessotto-Desktop-Aiuto-Claude\e2d17484-cba4-462a-b4dc-360d8b21d8a6\scratchpad`;

const CONFIG = {
  base: 'https://operations.hellofresh.com',
  brand: 'Factor',
  market: 'eu',
  stateFile: path.join(__dir, 'generated-wos.json'),
  outDir: process.env.FACTOR_OUT || 'G:\\Shared drives\\Recipe  Bible',
};

const tokenRaw = fs.readFileSync(path.join(__dir, 'tmp-token.txt'), 'utf8').trim();
if (!tokenRaw) { console.error('NO TOKEN'); process.exit(1); }

async function hfApi(url, opts = {}) {
  const r = await fetch(url, {
    method: opts.method || 'GET',
    headers: { accept: 'application/json', 'content-type': 'application/json', authorization: 'Bearer ' + tokenRaw },
    body: opts.body,
  });
  const json = await r.json().catch(() => null);
  return { status: r.status, json };
}

const gramsOf = arr => Array.isArray(arr)
  ? (arr.find(x => x.unitOfMeasure === 'grams')?.count ?? null)
  : (typeof arr === 'number' ? arr : null);

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

// ---- buildCards (inner cards only) + wrapDoc (full HTML doc) ----
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

// ---- matchWO ----
function matchWO(subName, woMap) {
  const n = (subName || '').toLowerCase();
  for (const [csvName, wo] of Object.entries(woMap)) {
    const c = csvName.toLowerCase();
    if (c && (n.includes(c.slice(0, 18)) || c.includes(n.slice(0, 18)))) return wo;
  }
  return null;
}

// ---- resolveMskuId ----
async function resolveMskuId(recCode) {
  const r = (await hfApi(`${CONFIG.base}/gw/scm/manufactured-sku-service/manufactured-skus?limit=25&offset=0&searchValue=${encodeURIComponent(recCode)}&brand=${CONFIG.brand}&market=${CONFIG.market}`)).json;
  return (r?.items || []).find(x => x.code === recCode)?.id || (r?.items || [])[0]?.id || null;
}

// ---- gatherRecipe ----
async function gatherRecipe(mskuId, portions, woByCsvSubName) {
  const alg = a => a ? { c: (a.allergens || []).map(x => biAllergen(x.name)) } : { c: [] };
  const det = (await hfApi(`${CONFIG.base}/gw/scm/manufactured-sku-service/v4/manufactured-skus/${mskuId}?brand=${CONFIG.brand}&market=${CONFIG.market}`)).json;
  const subDetails = (det.billOfMaterials || []).map(b => {
    const { rti, capacityKg, unit } = classify(b.name, b.cookMethods || []);
    const wo = matchWO(b.name, woByCsvSubName);
    return { subRecipeId: b.skuId, name: b.name, rti, equipmentName: wo || '', maxEquipmentCapacityAmount: capacityKg ?? 10000, maxEquipmentCapacityUnit: unit };
  });
  const body = JSON.stringify([{ id: mskuId, portions, sourceLocation: 'BULK_VIEW', subRecipeDetails: subDetails.filter(s => !s.rti).map(({ subRecipeId, equipmentName, maxEquipmentCapacityAmount, maxEquipmentCapacityUnit }) => ({ subRecipeId, equipmentName, maxEquipmentCapacityAmount, maxEquipmentCapacityUnit })) }]);
  const traceId = randomUUID();
  const res = (await hfApi(`${CONFIG.base}/gw/scm/manufactured-sku-service/v2/bulk/pdf-export?traceId=${traceId}`, { method: 'POST', body })).json;
  const rec0 = res[0];
  const rec = { name: rec0.name, skuCode: rec0.skuCode, totalPortions: rec0.totalPortions, alg: alg(rec0.allergenData) };
  const subs = []; (rec0.primaryPackaging?.compartmentData || []).forEach(c => (c.billOfMaterials || []).forEach(b => subs.push(b)));
  const cache = {};
  const instrOnly = async id => {
    if (!id || cache[id]) return;
    cache[id] = { en: '', de: '' };
    try {
      const d = (await hfApi(`${CONFIG.base}/gw/scm/manufactured-sku-service/v4/manufactured-skus/${id}?brand=${CONFIG.brand}&market=${CONFIG.market}`)).json;
      cache[id] = { en: d.instructions?.find(i => i.language === 'English')?.instruction || '', de: d.instructions?.find(i => i.language === 'German')?.instruction || '' };
    } catch {}
  };
  const gv = a => (typeof a === 'number' ? a : gramsOf(a));
  const childrenOf = i => { const kids = []; (i.manufacturingProcess?.paths || []).forEach(p => (p.kitchenStations || []).forEach(ks => (ks.billOfMaterials || []).forEach(c => kids.push(mkNode(c))))); return kids; };
  const mkNode = i => ({ name: i.name, g: gv(i.totalAmount), manuf: i.isManufactured, id: i.id, children: childrenOf(i) });
  const collectManufIds = (nodes, acc) => { nodes.forEach(n => { if (n.manuf && n.id && !READY_MADE.test(n.name)) { acc.add(n.id); collectManufIds(n.children, acc); } }); return acc; };
  const out = [];
  for (const s of subs) {
    const ings = childrenOf(s);
    const ids = collectManufIds(ings, new Set([s.id]));
    for (const id of ids) await instrOnly(id);
    const cls = classify(s.name, s.cookMethods || []);
    out.push({ name: s.name, id: s.id, wo: matchWO(s.name, woByCsvSubName), cook: s.cookMethods, paths: (s.manufacturingProcess?.paths || []).map(p => p.name), batchCount: s.batchCount, batchQuantity: s.batchQuantity, portionA: s.portionAmount, portionU: s.portionUOM, scoop: s.portionMethods?.[0]?.colorName || '', alg: alg(s.allergenData), rti: cls.rti, totalNeeded: (s.portionAmount || 0) * rec0.totalPortions, ings });
  }
  return { rec, subs: out, cache };
}

// ---- Groups: 6 new WOs for Wed 05.08 + Fri 07.08 ----
const GROUPS = [
  {
    date: '2026-08-05',
    recCode: 'REC-013537-4-007',
    recName: 'FV0485A - Rosemary-tomato chicken - [DE]',
    newWOs: ['33-190'],
    variants: [
      { target: 350, subs: { 'Shredded Chicken - naturel': '33-190' } },
    ],
  },
  {
    date: '2026-08-07',
    recCode: 'REC-014250-4-004',
    recName: 'FV1169A - [DE] -Salmon and sweet soy dressing',
    newWOs: ['33-210'],
    variants: [
      { target: 426, subs: { 'Green beans - Sesame roasted CUT green beans with onion slices': '33-210' } },
    ],
  },
  {
    date: '2026-08-07',
    recCode: 'REC-032214-4-005',
    recName: 'FV1481B - [DE] - Thai Coconut Curry Barramundi',
    newWOs: ['33-209'],
    variants: [
      { target: 270, subs: { 'Asian Brown Jasmine with GGS': '33-209' } },
    ],
  },
  {
    date: '2026-08-07',
    recCode: 'REC-013943-4-004',
    recName: 'FV0257A - Greek style ground beef and feta [DE]',
    newWOs: ['33-217', '33-218'],
    variants: [
      { target: 600, subs: { 'Herbed feta': '33-217', 'Red peppers - Roasted diced \u00bc red bell peppers': '33-218' } },
    ],
  },
  {
    date: '2026-08-07',
    recCode: 'REC-013601-4-001',
    recName: 'FV1347A - Pot Roast Shredded Beef & Mash [DE]',
    newWOs: ['33-216'],
    variants: [
      { target: 750, subs: { 'Shredded Sous Vide Beef': '33-216' } },
    ],
  },
];

// ---- Main ----
const state = JSON.parse(fs.readFileSync(CONFIG.stateFile, 'utf8'));
const outDir = fs.existsSync(CONFIG.outDir) ? CONFIG.outDir : SCRATCH;
if (outDir === SCRATCH) log('WARNING: outDir not found, writing PDFs to scratchpad');

const authCheck = await hfApi(`${CONFIG.base}/gw/scm/manufactured-sku-service/manufactured-skus?limit=1&offset=0&brand=${CONFIG.brand}&market=${CONFIG.market}`);
if (authCheck.status === 401) { log('NOT AUTHENTICATED (401) — login required'); process.exit(1); }
log('Auth OK, status:', authCheck.status);

// Accumulate cards by date
const dayCards = {};
const dayWOs = {};
const errors = [];

for (const g of GROUPS) {
  try {
    log(`Processing ${g.recCode} (${g.date}) new WOs: ${g.newWOs.join(', ')}`);
    const mskuId = await resolveMskuId(g.recCode);
    if (!mskuId) { log('SKIP (no mskuId):', g.recCode); errors.push(`${g.recCode}: no mskuId`); continue; }
    log(`  mskuId: ${mskuId}`);
    const runN = (state.runCount[g.recCode] || 0) + 1;
    const newSet = new Set(g.newWOs);
    let rec = null, allSubs = [], mergedCache = {};
    for (const v of g.variants) {
      log(`  variant target=${v.target}`);
      const out = await gatherRecipe(mskuId, v.target, v.subs);
      if (!rec) rec = out.rec;
      const matched = out.subs.filter(s => s.wo && newSet.has(s.wo));
      log(`  matched ${matched.length}/${out.subs.length} subs: ${matched.map(s => s.name + ' → WO ' + s.wo).join(', ')}`);
      allSubs = allSubs.concat(matched);
      Object.assign(mergedCache, out.cache);
    }
    if (!allSubs.length) { log(`SKIP (no matched subs) for ${g.recCode}`); errors.push(`${g.recCode}: no matched subs`); continue; }
    const cards = buildCards(rec, allSubs, mergedCache, `RUN ${runN}`);
    if (!dayCards[g.date]) { dayCards[g.date] = ''; dayWOs[g.date] = []; }
    dayCards[g.date] += cards;
    dayWOs[g.date].push(...g.newWOs);
    g.newWOs.forEach(w => state.doneWO[w] = g.date);
    state.runCount[g.recCode] = runN;
    log(`  cards built for ${g.recCode} Run ${runN}`);
  } catch (e) {
    log('ERROR on', g.recCode, e.message, e.stack);
    errors.push(`${g.recCode}: ${e.message}`);
  }
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
  log(`Printing PDF: ${pdfFinal} (${dayWOs[date].length} WOs)`);
  execSync(`"${CHROME}" --headless=new --disable-gpu --no-pdf-header-footer --print-to-pdf="${pdfScratch}" "${fileUrl}"`, { stdio: 'pipe', timeout: 30000 });
  if (outDir !== SCRATCH) { fs.copyFileSync(pdfScratch, pdfFinal); fs.unlinkSync(pdfScratch); }
  fs.unlinkSync(htmlPath);
  generated.push({ file: pdfName, date, wos: dayWOs[date] });
  log(`MADE: ${pdfName}`);
}

fs.writeFileSync(CONFIG.stateFile, JSON.stringify(state, null, 1));
fs.unlinkSync(path.join(__dir, 'tmp-token.txt'));
log('=== DONE ===');
log(`Generated ${generated.length} PDFs, ${errors.length} errors`);
if (errors.length) log('Errors:', errors);
log('Generated:', JSON.stringify(generated, null, 2));
