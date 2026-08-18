// gather-build-aug11.mjs — fetch new W34/W35 WOs via GraphQL, gather recipe data, print PDFs
// Prerequisites: node recv-token.mjs → send token from browser → tmp-token.txt written
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { classify, isSpiceRoom, isSeparate, READY_MADE } from './capacity-rules.js';
import crypto from 'crypto';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log(new Date().toISOString(), ...a);

const TOKEN_FILE  = path.join(__dir, 'tmp-token.txt');
const STATE_FILE  = path.join(__dir, 'generated-wos.json');
const CHROME      = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SCRATCH     = String.raw`C:\Users\MATTEO~1\AppData\Local\Temp\claude\C--Users-MatteoSpessotto-Desktop-Aiuto-Claude\6b259430-5c4f-4d73-9863-f9fe455cc55f\scratchpad`;
const OUT_BASE    = process.env.FACTOR_OUT || 'G:\\Shared drives\\Recipe  Bible';
const BASE        = 'https://operations.hellofresh.com';
const BRAND       = 'Factor';
const MARKET      = 'eu';
const VERDEN_UUID = 'beb3e519-a33f-4f32-a4f5-e7e47e773940';

if (!fs.existsSync(TOKEN_FILE)) { log('ERROR: tmp-token.txt not found'); process.exit(1); }
const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
if (!token || token.length < 50) { log('ERROR: token empty or too short'); process.exit(1); }
log('Token OK (' + token.length + ' chars)');

// ── API helpers ──────────────────────────────────────────────────────────────
const hdr = () => ({ authorization: 'Bearer ' + token, accept: 'application/json', 'content-type': 'application/json' });

async function apiGet(url) {
  const r = await fetch(url, { headers: hdr() });
  if (!r.ok) throw new Error(`GET ${url.split('/').slice(-3).join('/')} → ${r.status}`);
  return r.json();
}
async function apiPost(url, body) {
  const r = await fetch(url, { method: 'POST', headers: hdr(), body });
  if (!r.ok) { const t = await r.text(); throw new Error(`POST ${url.split('/').slice(-3).join('/')} → ${r.status}: ${t.substring(0,200)}`); }
  return r.json();
}
async function gql(endpoint, query) {
  const r = await fetch(`${BASE}/gw/scm/${endpoint}/graphql`, { method: 'POST', headers: hdr(), body: JSON.stringify({ query }) });
  return r.json();
}

// ── Allergens ────────────────────────────────────────────────────────────────
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
const mkAlg = a => a ? { c: (a.allergens || []).map(x => biAllergen(x.name)) } : { c: [] };
const gramsOf = arr => Array.isArray(arr) ? (arr.find(x => x.unitOfMeasure === 'grams')?.count ?? null) : (typeof arr === 'number' ? arr : null);

// ── BOM tree helpers ─────────────────────────────────────────────────────────
function mkNode(i) {
  const kids = [];
  (i.manufacturingProcess?.paths || []).forEach(p => (p.kitchenStations || []).forEach(ks => (ks.billOfMaterials || []).forEach(c => kids.push(mkNode(c)))));
  return { name: i.name, g: gramsOf(i.totalAmount), manuf: i.isManufactured, id: i.id, children: kids };
}
function collectManufIds(nodes, acc) {
  nodes.forEach(n => { if (n.manuf && n.id && !READY_MADE.test(n.name)) { acc.add(n.id); collectManufIds(n.children, acc); } });
  return acc;
}
function matchWO(subName, woMap) {
  const n = (subName || '').toLowerCase();
  for (const [csvName, wo] of Object.entries(woMap)) {
    const c = csvName.toLowerCase();
    if (c && (n.includes(c.slice(0, 18)) || c.includes(n.slice(0, 18)))) return wo;
  }
  return null;
}

// ── resolveMskuId ────────────────────────────────────────────────────────────
async function resolveMskuId(recCode, recName) {
  for (const sv of [recCode, recName]) {
    const r = await apiGet(`${BASE}/gw/scm/manufactured-sku-service/manufactured-skus?limit=25&offset=0&searchValue=${encodeURIComponent(sv)}&brand=${BRAND}&market=${MARKET}`);
    const item = (r?.items || []).find(x => x.code === recCode) || (r?.items || [])[0];
    if (item) return item.id;
  }
  return null;
}

// ── gatherGroup ──────────────────────────────────────────────────────────────
async function gatherGroup(mskuId, portions, woBySub) {
  const det = await apiGet(`${BASE}/gw/scm/manufactured-sku-service/v4/manufactured-skus/${mskuId}?brand=${BRAND}&market=${MARKET}`);
  const subDetails = (det.billOfMaterials || []).map(b => {
    const { rti, capacityKg, unit } = classify(b.name, b.cookMethods || []);
    return { subRecipeId: b.skuId, name: b.name, rti, equipmentName: matchWO(b.name, woBySub) || '', maxEquipmentCapacityAmount: capacityKg ?? 10000, maxEquipmentCapacityUnit: unit };
  });
  const body = JSON.stringify([{
    id: mskuId, portions, sourceLocation: 'BULK_VIEW',
    subRecipeDetails: subDetails.filter(s => !s.rti).map(({ subRecipeId, equipmentName, maxEquipmentCapacityAmount, maxEquipmentCapacityUnit }) =>
      ({ subRecipeId, equipmentName, maxEquipmentCapacityAmount, maxEquipmentCapacityUnit }))
  }]);
  const res = await apiPost(`${BASE}/gw/scm/manufactured-sku-service/v2/bulk/pdf-export?traceId=${crypto.randomUUID()}`, body);
  const rec0 = res[0];
  const rec = { name: rec0.name, skuCode: rec0.skuCode, totalPortions: rec0.totalPortions, alg: mkAlg(rec0.allergenData) };
  const allSubs = [];
  (rec0.primaryPackaging?.compartmentData || []).forEach(c => (c.billOfMaterials || []).forEach(b => allSubs.push(b)));
  const cache = {};
  async function instrOnly(id) {
    if (!id || cache[id]) return;
    cache[id] = { en: '', de: '' };
    try {
      const d = await apiGet(`${BASE}/gw/scm/manufactured-sku-service/v4/manufactured-skus/${id}?brand=${BRAND}&market=${MARKET}`);
      const join = lang => (d.instructions || []).filter(i => i.language === lang).sort((a, b) => a.step - b.step).map(i => i.instruction).join('\n\n');
      cache[id] = { en: join('English'), de: join('German') };
    } catch {}
  }
  const out = [];
  for (const s of allSubs) {
    const ings = (s.manufacturingProcess?.paths || []).flatMap(p => (p.kitchenStations || []).flatMap(ks => (ks.billOfMaterials || []).map(c => mkNode(c))));
    const ids = collectManufIds(ings, new Set([s.id]));
    for (const id of ids) await instrOnly(id);
    const cls = classify(s.name, s.cookMethods || []);
    out.push({
      name: s.name, id: s.id, wo: matchWO(s.name, woBySub),
      cook: s.cookMethods, paths: (s.manufacturingProcess?.paths || []).map(p => p.name),
      batchCount: s.batchCount, batchQuantity: s.batchQuantity,
      portionA: s.portionAmount, portionU: s.portionUOM,
      scoop: s.portionMethods?.[0]?.colorName || '',
      alg: mkAlg(s.allergenData), rti: cls.rti,
      totalNeeded: (s.portionAmount || 0) * rec0.totalPortions, ings
    });
  }
  return { rec, subs: out, cache };
}

// ── buildCards ───────────────────────────────────────────────────────────────
function buildCards(rec, subs, cache, runLabel) {
  const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
  const fmt = t => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/"([^"]{1,60}?)"/g, '"<span class=setup>$1</span>"').replace(/\n+/g, '<br>');
  const q = g => (g == null || isNaN(g)) ? '—' : (g < 1000 ? Math.round(g) + ' g' : (g/1000).toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' kg');
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

// ── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  log('=== W34/W35 New WO PDF Builder ===');
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  const doneWOs = new Set(Object.keys(state.doneWO || {}));
  const outDir = fs.existsSync(OUT_BASE) ? OUT_BASE : SCRATCH;
  if (outDir === SCRATCH) log('WARNING: G: drive not found, writing to scratchpad instead');

  // Step 1: Fetch all sub-recipes
  log('Fetching W34+W35 sub-recipes via GraphQL...');
  const resp = await gql('rte-execution-tracker', `{
    getBatchedSubRecipesExport(dcId: "${VERDEN_UUID}", menuWeeks: [{year:2026,week:34},{year:2026,week:35}]) {
      subRecipes {
        subRecipeName workOrderNumber targetPortions cookMethods
        productionShift { date shift }
        recipes { recipeCode recipeName }
      }
    }
  }`);
  const rows = resp?.data?.getBatchedSubRecipesExport?.subRecipes || [];
  log(`Got ${rows.length} sub-recipe rows from GraphQL`);

  // Step 2: Group new rows by (recCode, date, target)
  const variants = {}; // key: recCode|date|target
  for (const r of rows) {
    if (doneWOs.has(r.workOrderNumber)) continue;
    const date = r.productionShift?.date || 'unknown';
    for (const rec of (r.recipes || [])) {
      const vk = `${rec.recipeCode}|${date}|${r.targetPortions}`;
      if (!variants[vk]) variants[vk] = { recCode: rec.recipeCode, recName: rec.recipeName, date, target: r.targetPortions, woBySub: {}, allWOs: [] };
      if (!variants[vk].woBySub[r.subRecipeName]) variants[vk].woBySub[r.subRecipeName] = r.workOrderNumber;
      if (!variants[vk].allWOs.includes(r.workOrderNumber)) variants[vk].allWOs.push(r.workOrderNumber);
    }
  }
  const variantList = Object.values(variants).sort((a, b) => (a.date + a.recCode + a.target).localeCompare(b.date + b.recCode + b.target));
  log(`New variants to gather: ${variantList.length}`);
  if (!variantList.length) { log('Nothing new. Exiting.'); return; }

  // The full set of new WOs (for filtering subs that have a WO)
  const newWOSet = new Set(variantList.flatMap(v => v.allWOs));

  // Step 3: Resolve mskuIds (one per unique recCode)
  const mskuCache = {};
  const uniqueRecs = [...new Set(variantList.map(v => v.recCode))];
  for (const rc of uniqueRecs) {
    const v0 = variantList.find(v => v.recCode === rc);
    log(`  resolveMskuId ${rc}...`);
    mskuCache[rc] = await resolveMskuId(rc, v0.recName);
    if (!mskuCache[rc]) log(`  WARN: no mskuId for ${rc}`);
  }

  // Step 4: Gather API data per variant; accumulate per (recCode, date)
  // byRecDate[rc|date] = { recCode, date, rec, allSubs[], cache }
  const byRecDate = {};
  for (const v of variantList) {
    const mskuId = mskuCache[v.recCode];
    if (!mskuId) { log(`SKIP (no mskuId): ${v.recCode} [${v.target}p] ${v.date}`); continue; }
    log(`Gathering ${v.recCode} [${v.target}p] ${v.date}...`);
    try {
      const { rec, subs, cache } = await gatherGroup(mskuId, v.target, v.woBySub);
      const dk = `${v.recCode}|${v.date}`;
      if (!byRecDate[dk]) byRecDate[dk] = { recCode: v.recCode, date: v.date, rec, allSubs: [], cache };
      byRecDate[dk].allSubs.push(...subs.filter(s => s.wo && newWOSet.has(s.wo)));
      Object.assign(byRecDate[dk].cache, cache);
    } catch (e) {
      log(`ERROR gathering ${v.recCode} [${v.target}p] ${v.date}: ${e.message}`);
    }
  }

  // Step 5: Build cards per (recCode, date); group into one PDF per date
  const dayCards = {}; // date → html cards string
  const dayWOs = {};   // date → [wo, ...]
  const usedRunN = {}; // recCode → runN used (to avoid double-incrementing)

  for (const item of Object.values(byRecDate).sort((a, b) => (a.date + a.recCode).localeCompare(b.date + b.recCode))) {
    if (!item.allSubs.length) { log(`SKIP (no subs with WOs): ${item.recCode} ${item.date}`); continue; }
    if (!(item.recCode in usedRunN)) usedRunN[item.recCode] = (state.runCount[item.recCode] || 0) + 1;
    const runN = usedRunN[item.recCode];
    log(`Building cards: ${item.recCode} → RUN ${runN} (${item.allSubs.length} subs, ${item.date})`);
    const cards = buildCards(item.rec, item.allSubs, item.cache, `RUN ${runN}`);
    (dayCards[item.date] = (dayCards[item.date] || '') + cards);
    (dayWOs[item.date] = dayWOs[item.date] || []).push(...item.allSubs.map(s => s.wo).filter(Boolean));
  }

  // Step 6: Print one PDF per date via Chrome headless
  const WEEKDAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const now = new Date();
  const hhmm = String(now.getHours()).padStart(2,'0') + String(now.getMinutes()).padStart(2,'0');
  const generated = [];

  for (const [date, cards] of Object.entries(dayCards).sort()) {
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
    log(`Printing ${pdfName} (WOs: ${dayWOs[date].join(', ')})...`);
    try {
      execSync(`"${CHROME}" --headless=new --disable-gpu --no-pdf-header-footer --print-to-pdf="${pdfScratch}" "${fileUrl}"`, { stdio: 'pipe', timeout: 90000 });
      if (outDir !== SCRATCH) { fs.copyFileSync(pdfScratch, pdfFinal); fs.unlinkSync(pdfScratch); }
      else { pdfFinal === pdfScratch || (pdfFinal !== pdfScratch && fs.existsSync(pdfScratch)); }
      if (fs.existsSync(htmlPath)) fs.unlinkSync(htmlPath);
      generated.push({ file: pdfName, path: pdfFinal, wos: dayWOs[date] });
      log(`MADE: ${pdfFinal}`);
    } catch (e) {
      log(`ERROR printing ${pdfName}: ${e.message}`);
      if (fs.existsSync(htmlPath)) fs.unlinkSync(htmlPath);
    }
  }

  // Step 7: Update state — mark all new WOs done, update runCounts
  for (const v of variantList) {
    if (!mskuCache[v.recCode]) continue; // was skipped
    v.allWOs.forEach(w => { state.doneWO[w] = v.date; });
  }
  for (const [rc, n] of Object.entries(usedRunN)) {
    state.runCount[rc] = n;
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
  log('State saved.');
  log(`=== DONE: ${generated.length} PDFs generated, ${Object.keys(usedRunN).length} recipes ===`);
  generated.forEach(g => log(`  ${g.file} (${g.wos.length} WOs)`));
}

main().catch(e => { log('FATAL:', e.message, '\n', e.stack); process.exit(1); });
