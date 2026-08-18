// Factor Recipe Bot — Strada B (standalone Playwright service)
// See README.md. One-time: `node bot.mjs --login`.  Scheduled/manual: `node bot.mjs`.
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { classify, isSpiceRoom, isSeparate, READY_MADE } from './capacity-rules.js';

const __dir = path.dirname(fileURLToPath(import.meta.url));

// ============================== CONFIG ==============================
const CONFIG = {
  base: 'https://operations.hellofresh.com',
  brand: 'Factor',
  market: 'eu',
  distributionCenter: 'Verden',
  userDataDir: path.join(__dir, 'chrome-profile'),
  stateFile: path.join(__dir, 'generated-wos.json'),
  // Synced shared-Drive folder, confirmed by Matteo 2026-07-12:
  outDir: process.env.FACTOR_OUT || 'G:\\Shared drives\\Recipe  Bible',
};
// ====================================================================

const log = (...a) => console.log(new Date().toISOString(), ...a);

function isoWeek(d) {
  const dt = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = dt.getUTCDay() || 7; dt.setUTCDate(dt.getUTCDate() + 4 - day);
  const yStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const wk = Math.ceil((((dt - yStart) / 86400000) + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(wk).padStart(2, '0')}`;
}
function todayStr(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function kwFromDateStr(s) {
  let d;
  if (/^\d{2}\.\d{2}\.\d{4}$/.test(s)) { const [dd,mm,yyyy]=s.split('.'); d=new Date(+yyyy,+mm-1,+dd); }
  else if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) { const [mm,dd,yyyy]=s.split('/'); d=new Date(+yyyy,+mm-1,+dd); }
  else d=new Date(s);
  const dt=new Date(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate()));
  const day=dt.getUTCDay()||7; dt.setUTCDate(dt.getUTCDate()+4-day);
  const yStart=new Date(Date.UTC(dt.getUTCFullYear(),0,1));
  return Math.ceil((((dt-yStart)/86400000)+1)/7);
}

// minimal CSV parser (handles quoted fields with commas/newlines)
function parseCSV(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) { const c = text[i];
    if (q) { if (c === '"') { if (text[i+1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else { if (c === '"') q = true; else if (c === ',') { row.push(cur); cur = ''; } else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; } else if (c === '\r') {} else cur += c; }
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

// ---- API helpers (run in the authenticated page context) ----
async function api(page, url, opts = {}) {
  return page.evaluate(async ({ url, opts }) => {
    const token = localStorage.getItem('operation.azure.token');
    const r = await fetch(url, { method: opts.method || 'GET', headers: { accept: 'application/json', 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: opts.body });
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, json: ct.includes('json') ? await r.json() : null, text: ct.includes('json') ? null : await r.text() };
  }, { url, opts });
}
const gramsOf = (arr) => Array.isArray(arr) ? (arr.find(x => x.unitOfMeasure === 'grams')?.count ?? null) : (typeof arr === 'number' ? arr : null);

// Allergen names come from the API in German only. Layout is EN + DE everywhere else, so allergens
// must be bilingual too (Matteo, 2026-07-13) — NEVER Italian. Unknown names fall back to German-only.
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

// ---------- HTML builder (identical logic to the validated v10) ----------
function buildHtml(rec, subs, cache, runLabel) {
  const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
  const fmt = t => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/"([^"]{1,60}?)"/g, '"<span class=setup>$1</span>"').replace(/\n+/g, '<br>');
  const q = g => (g == null || isNaN(g)) ? '—' : (g < 1000 ? Math.round(g) + ' g' : (g/1000).toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' kg');
  const nm = n => `${esc(n)}${isSeparate(n) ? ' <span class=sep>SEPARATE</span>' : ''}`;
  const qc = (n, g) => `<td class="r">${q(g)}</td>`;
  // spice rows get ONE continuous underline (row bottom-border) from the ingredient name to the last
  // quantity column, instead of separate text-decoration underlines per cell (which looked fragmented)
  const rowCls = (spice, ...extra) => [...extra, spice ? 'spice' : ''].filter(Boolean).join(' ');
  const ctx = `<div class=ctx><b>${esc(rec.name)}</b> · ${esc(rec.skuCode)} · ${rec.totalPortions} portions · ${esc(runLabel)}</div>`;
  // TRACES omitted on purpose (Matteo, 2026-07-13): not relevant for kitchen ops, only CONTAINS matters.
  const algBox = a => { const c = a?.c || []; if (!c.length) return ''; return `<div class=algBox><div class=algRow><span class=algLc>⚠ CONTAINS</span>${c.map(x => `<span class=badC>${esc(x)}</span>`).join('')}</div></div>`; };
  const tableWrap = r => `<table class=ing><thead><tr><th>Ingredient</th><th class=r>Per batch</th><th class=r>Total</th></tr></thead><tbody>${r}</tbody></table>`;
  const instrBlock = (en, de, label) => (en || de) ? `<div class=instr><div class=ic><div class=ih>${label ? label + ' — ' : ''}INSTRUCTIONS (EN)</div>${fmt(en) || '—'}</div><div class=ic><div class=ih>${label ? label + ' — ' : ''}ANLEITUNG (DE)</div>${fmt(de) || '—'}</div></div>` : '';
  // salt-aware name cell: in a brine block, salt is portioned separately → underline + SEPARATE tag
  const nmSalt = n => { const salt = /salt|salz/i.test(n); return `${esc(n)}${isSeparate(n) || salt ? ' <span class=sep>SEPARATE</span>' : ''}`; };
  // Underlined (spice-room / SEPARATE) ingredients always sort first in the table (Matteo, 2026-07-16):
  // faster picking — the spice-room items to gather are all at the top, not scattered through the list.
  // Stable sort: within each group (underlined vs not) original API order is preserved.
  const spiceFirst = (arr, saltAlso) => [...arr].sort((a, b) => {
    const sa = (isSpiceRoom(a.name) || (saltAlso && /salt|salz/i.test(a.name))) ? 1 : 0;
    const sb = (isSpiceRoom(b.name) || (saltAlso && /salt|salz/i.test(b.name))) ? 1 : 0;
    return sb - sa;
  });
  const cards = subs.map(s => {
    const rti = s.rti; const B = s.batchCount || 1;
    const bq = s.batchQuantity != null ? Math.ceil(s.batchQuantity) : null;
    const batch = rti ? '<span class=rti>RTI · Ready to Eat → Plating</span>' : (s.batchCount != null ? `<b>${s.batchCount}</b> × ${bq} kg` : '—');
    const process = (s.paths || []).map(esc).join(' | ') || '—';
    // No fallback to rec.alg (Matteo, 2026-07-13): verified via API that every sub-recipe always
    // carries its own computed allergenData (never null) — an empty array means "genuinely zero
    // allergens in this batch", not "missing data". Falling back to the parent recipe's allergens
    // was wrongly tagging allergen-free batches (e.g. Green Beans, Green Onions) with allergens from
    // unrelated sub-recipes in the same dish, which broke blast-chiller grouping by true allergen profile.
    const A = s.alg;
    const subD = cache[s.id] || {};
    const isMar = /marinad|marinat|mariniert/i.test((subD.en || '') + (subD.de || ''));
    // recursively render a node's nested children, using the REAL production weight (node.g) at each level
    // straight from the pdf-export tree — NO proportional scaling (that wrongly forced raw = cooked; e.g.
    // it now correctly shows raw ground beef 130kg above its cooked 93kg). READY_MADE items (Roasted
    // Garlic / Oil) never expand at any depth.
    const expand = (children, depth) => {
      let out = '';
      spiceFirst(children || []).forEach(x => {
        const ready = READY_MADE.test(x.name);
        const deeper = !ready && x.manuf && (x.children || []).length && depth < 5;
        const tag = ready ? ' <span class=rdy>ready · weekly prep</span>' : (deeper ? ' <span class=tag>sub ↓</span>' : '');
        out += `<tr class="${rowCls(isSpiceRoom(x.name), 'nest')}"><td style="padding-left:${10 + depth * 14}px">↳ ${nm(x.name)}${tag}</td>${qc(x.name, x.g / B)}${qc(x.name, x.g)}</tr>`;
        if (deeper) out += expand(x.children, depth + 1);
      });
      return out;
    };
    // one ingredient row + nested sub-recipe expansion (children already carry real weights)
    const normalRow = i => {
      const ready = i.manuf && READY_MADE.test(i.name);
      const noExp = i.manuf && /yielded/i.test(i.name); // e.g. "Heavy Cream- Yielded" → plain ingredient, show only its quantity
      const isBrine = i.manuf && /brine|brined/i.test(i.name);
      const tag = !i.manuf ? '' : ready ? ' <span class=rdy>ready · weekly prep</span>' : noExp ? '' : isBrine ? ' <span class=brineTag>BRINE ↓</span>' : ' <span class=tag>sub-recipe ↓</span>';
      let out = `<tr class="${rowCls(isSpiceRoom(i.name), i.manuf && !noExp ? 'mf' : '')}"><td>${nm(i.name)}${tag}</td>${qc(i.name, i.g != null ? i.g / B : null)}${qc(i.name, i.g)}</tr>`;
      if (i.manuf && !ready && !noExp && (i.children || []).length) out += expand(i.children, 1);
      return out;
    };
    let body;
    const brinedIng = rti ? null : (s.ings || []).find(i => i.manuf && /brine|brined/i.test(i.name));
    if (brinedIng && isMar) {
      // Brine + marinade recipe → BRINE sub-recipe first, then MARINADE. brinedIng.children come from the
      // pdf-export tree with REAL production weights (salt, water, raw protein) — no scaling needed.
      const nb = brinedIng.children || [];
      // Net protein carried into the marinade = the real raw protein weight = sum of the brine's own
      // ingredients EXCLUDING water and salt (which are process inputs, not shippable product, and NOT
      // part of the meat weight). This is the true raw meat quantity — greater than cooked, water excluded.
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
      if (rti) rows = `<tr class="${rowCls(isSpiceRoom(s.name), 'mf')}"><td>${nm(s.name)}</td>${qc(s.name, s.totalNeeded)}${qc(s.name, s.totalNeeded)}</tr>`;
      else spiceFirst(s.ings || []).forEach(i => { rows += normalRow(i); });
      let instr = instrBlock(subD.en, subD.de);
      (s.ings || []).forEach(i => { if (i.manuf && !READY_MADE.test(i.name) && !/yielded/i.test(i.name) && cache[i.id] && (cache[i.id].en || cache[i.id].de)) { const c = cache[i.id]; const isBrine = /brine|brined/i.test(i.name); const hdr = isBrine ? `🧂 BRINE — ${esc(i.name)}` : `↳ ${esc(i.name)} — sub-recipe`; instr += `<div class="nestInstr${isBrine ? ' brineBox' : ''}"><div class=nih>${hdr}</div>${instrBlock(c.en, c.de)}</div>`; } });
      body = tableWrap(rows) + instr;
    }
    return `<div class=page><div class="card${rti ? ' rtiCard' : ''}">${ctx}<div class=ch><span class=sn>${esc(s.name)}</span><span class=wo>WO ${esc(s.wo || '-')}</span></div>${algBox(A)}
      <div class=cm><span><b>Cooking:</b> ${esc((s.cook || []).join(', ') || '—')}</span><span><b>Process:</b> ${process}</span><span><b>Batches:</b> ${batch}</span><span><b>Portion:</b> ${s.portionA ?? ''} ${esc(s.portionU || '')}${s.scoop ? ' · scoop ' + esc(s.scoop) : ''}</span></div>
      ${body}</div></div>`;
  }).join('');
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

// ---------- data gathering for one recipe (mskuId + WO map from ET) ----------
async function gatherRecipe(page, mskuId, portions, woByCsvSubName) {
  // TRACES intentionally dropped (Matteo, 2026-07-13) — only CONTAINS matters for kitchen ops.
  const alg = a => a ? { c: (a.allergens || []).map(x => biAllergen(x.name)) } : { c: [] };
  // v4 detail -> subRecipe ids (billOfMaterials) to build the pdf-export request
  const det = (await api(page, `${CONFIG.base}/gw/scm/manufactured-sku-service/v4/manufactured-skus/${mskuId}?brand=${CONFIG.brand}&market=${CONFIG.market}`)).json;
  const subDetails = (det.billOfMaterials || []).map(b => {
    const { rti, capacityKg, unit } = classify(b.name, b.cookMethods || []);
    const wo = matchWO(b.name, woByCsvSubName);
    return { subRecipeId: b.skuId, name: b.name, rti, equipmentName: wo || '', maxEquipmentCapacityAmount: capacityKg ?? 10000, maxEquipmentCapacityUnit: unit };
  });
  const body = JSON.stringify([{ id: mskuId, portions, sourceLocation: 'BULK_VIEW', subRecipeDetails: subDetails.filter(s => !s.rti).map(({ subRecipeId, equipmentName, maxEquipmentCapacityAmount, maxEquipmentCapacityUnit }) => ({ subRecipeId, equipmentName, maxEquipmentCapacityAmount, maxEquipmentCapacityUnit })) }]);
  const traceId = crypto.randomUUID();
  const res = (await api(page, `${CONFIG.base}/gw/scm/manufactured-sku-service/v2/bulk/pdf-export?traceId=${traceId}`, { method: 'POST', body })).json;
  const rec0 = res[0];
  const rec = { name: rec0.name, skuCode: rec0.skuCode, totalPortions: rec0.totalPortions, alg: alg(rec0.allergenData) };
  const subs = []; (rec0.primaryPackaging?.compartmentData || []).forEach(c => (c.billOfMaterials || []).forEach(b => subs.push(b)));
  const cache = {};
  // Instructions ONLY (en/de) per sub-recipe id — NOT weights/bom. The pdf-export response's own nested
  // manufacturingProcess tree is the authoritative source for quantities at every depth (it already gives
  // the true RAW vs COOKED weights — e.g. Ground Beef raw 130kg → cooked 93kg), so we must NOT recompute
  // nested quantities by proportional scaling of the v4 base bom (that wrongly forced raw = cooked, the
  // meat bug Matteo flagged 2026-07-16). v4 detail is fetched only to get cooking instructions.
  const instrOnly = async id => {
    if (!id || cache[id]) return;
    cache[id] = { en: '', de: '' };
    try {
      const d = (await api(page, `${CONFIG.base}/gw/scm/manufactured-sku-service/v4/manufactured-skus/${id}?brand=${CONFIG.brand}&market=${CONFIG.market}`)).json;
      const joinInstr = lang => (d.instructions || []).filter(i => i.language === lang).sort((a, b) => a.step - b.step).map(i => i.instruction).join('\n\n');
      cache[id] = { en: joinInstr('English'), de: joinInstr('German') };
    } catch {}
  };
  // Build an ingredient node (with its full nested children tree) straight from the pdf-export response.
  // Every totalAmount here is the real production weight at that level — no scaling applied.
  const gv = a => (typeof a === 'number' ? a : gramsOf(a));
  const childrenOf = i => { const kids = []; (i.manufacturingProcess?.paths || []).forEach(p => (p.kitchenStations || []).forEach(ks => (ks.billOfMaterials || []).forEach(c => kids.push(mkNode(c))))); return kids; };
  const mkNode = i => ({ name: i.name, g: gv(i.totalAmount), manuf: i.isManufactured, id: i.id, children: childrenOf(i) });
  const collectManufIds = (nodes, acc) => { nodes.forEach(n => { if (n.manuf && n.id && !READY_MADE.test(n.name)) { acc.add(n.id); collectManufIds(n.children, acc); } }); return acc; };
  const out = [];
  for (const s of subs) {
    const ings = childrenOf(s); // top-level ingredients, each carrying its own nested tree with real weights
    const ids = collectManufIds(ings, new Set([s.id])); // sub itself + every manufactured node (for instructions)
    for (const id of ids) await instrOnly(id);
    const cls = classify(s.name, s.cookMethods || []);
    out.push({ name: s.name, id: s.id, wo: matchWO(s.name, woByCsvSubName), cook: s.cookMethods, paths: (s.manufacturingProcess?.paths || []).map(p => p.name), batchCount: s.batchCount, batchQuantity: s.batchQuantity, portionA: s.portionAmount, portionU: s.portionUOM, scoop: s.portionMethods?.[0]?.colorName || '', alg: alg(s.allergenData), rti: cls.rti, totalNeeded: (s.portionAmount || 0) * rec0.totalPortions, ings });
  }
  return { rec, subs: out, cache };
}
function matchWO(subName, woMap) { const n = (subName || '').toLowerCase(); for (const [csvName, wo] of Object.entries(woMap)) { const c = csvName.toLowerCase(); if (c && (n.includes(c.slice(0, 18)) || c.includes(n.slice(0, 18)))) return wo; } return null; }

async function resolveMskuId(page, recCode, recName) {
  for (const sv of [recCode, recName]) {
    const r = (await api(page, `${CONFIG.base}/gw/scm/manufactured-sku-service/manufactured-skus?limit=25&offset=0&searchValue=${encodeURIComponent(sv)}&brand=${CONFIG.brand}&market=${CONFIG.market}`)).json;
    const item = (r?.items || []).find(x => x.code === recCode) || (r?.items || [])[0];
    if (item) return item.id;
  }
  return null;
}

async function main() {
  const isLogin = process.argv.includes('--login');
  fs.mkdirSync(CONFIG.userDataDir, { recursive: true });
  fs.mkdirSync(CONFIG.outDir, { recursive: true });
  const ctx = await chromium.launchPersistentContext(CONFIG.userDataDir, { headless: !isLogin, acceptDownloads: true, viewport: { width: 1400, height: 900 } });
  const page = ctx.pages()[0] || await ctx.newPage();

  if (isLogin) {
    await page.goto(`${CONFIG.base}/manufactured-sku/home?brand=${CONFIG.brand}&market=${CONFIG.market}`);
    log('Log into HelloFresh in the opened browser. When the SKU list is visible, press Ctrl+C to finish. Session is saved.');
    await page.waitForTimeout(600000); await ctx.close(); return;
  }

  await page.goto(`${CONFIG.base}/manufactured-sku/home?brand=${CONFIG.brand}&market=${CONFIG.market}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  const token = await page.evaluate(() => localStorage.getItem('operation.azure.token'));
  const ok = token && (await api(page, `${CONFIG.base}/gw/scm/manufactured-sku-service/manufactured-skus?limit=1&offset=0&brand=${CONFIG.brand}&market=${CONFIG.market}`)).status === 200;
  if (!ok) { log('NOT AUTHENTICATED — run: node bot.mjs --login'); await ctx.close(); process.exit(1); }

  const now = new Date();
  const menuWeek = isoWeek(now);
  const today = todayStr(now);
  log('Screening', { menuWeek, today, dc: CONFIG.distributionCenter });

  // --- get ET CSV via UI download ---
  await page.goto(`${CONFIG.base}/rte-execution-tracking/execution-tracking?distributionCenter=${CONFIG.distributionCenter}&menuWeek=${menuWeek}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);
  const dl = await Promise.all([
    page.waitForEvent('download'),
    page.getByText('Export to CSV', { exact: false }).first().click(),
  ]).then(([d]) => d).catch(() => null);
  if (!dl) { log('Could not export ET CSV (UI changed?)'); await ctx.close(); process.exit(1); }
  const csvPath = path.join(__dir, 'et.csv'); await dl.saveAs(csvPath);
  const rows = parseCSV(fs.readFileSync(csvPath, 'utf8'));
  const header = rows.shift();
  const col = name => header.findIndex(h => h.trim().toLowerCase() === name.toLowerCase());
  const [cDate, cWO, cRecId, cRecName, cSub, cCook, cTarget] = [col('Date Needed'), col('Work Order Number'), col('Recipe ID'), col('Recipe Name'), col('Sub Recipe Name'), col('Cook Methods'), col('Target Portions')];

  // --- state (already generated WOs) ---
  const state = fs.existsSync(CONFIG.stateFile) ? JSON.parse(fs.readFileSync(CONFIG.stateFile, 'utf8')) : { doneWO: {}, runCount: {} };

  // group rows by recipe + dateNeeded (date+shift) — a production sheet.
  // ⚠️ BUG FOUND 2026-07-28 (Matteo: "il WO 202 le porzioni non erano corrette"): a single recCode+date
  // group can contain WOs with DIFFERENT "Target Portions" — e.g. W32 2026-07-29 shift2, recipe
  // REC-030480-4-001: WO 32-201 (Low Fat Red Pepper Fondue) target=1200, WO 32-202 (Shredded Chicken
  // Thighs) target=280 — a partial per-sub top-up, not the same production run. Taking Math.max() across
  // the group (old code) fed 1200 into the pdf-export call for BOTH subs, inflating 32-202's ingredient
  // weights ~4.3x. Fix: sub-group by (recCode, date, target) — each distinct target within the same
  // recCode+date becomes its own pdf-export call (own `portions`), then merge the resulting subs back
  // into ONE combined card set for that recCode+date, still under a single Run N (it's one production
  // event on the floor, just with mixed per-sub quantities).
  const groups = {};
  for (const r of rows) {
    if (!r[cWO]) continue;
    const target = parseInt(r[cTarget] || '0', 10) || 0;
    const key = r[cRecId] + '||' + r[cDate];
    const vkey = key + '||' + target;
    (groups[key] ||= { recCode: r[cRecId], recName: r[cRecName], date: r[cDate], wos: [], variants: {} });
    (groups[key].variants[vkey] ||= { target, subs: {} });
    groups[key].wos.push(r[cWO]);
    groups[key].variants[vkey].subs[r[cSub]] = r[cWO];
  }

  let made = 0;
  for (const g of Object.values(groups)) {
    const newWOs = g.wos.filter(w => !state.doneWO[w]);
    if (!newWOs.length) continue; // nothing new in this group
    try {
      const mskuId = await resolveMskuId(page, g.recCode, g.recName);
      if (!mskuId) { log('SKIP (no mskuId):', g.recCode, g.recName); continue; }
      const runN = (state.runCount[g.recCode] || 0) + 1;
      const newSet = new Set(newWOs);
      // one pdf-export call PER distinct target-portions value in this group, subs merged after
      let rec = null, allSubs = [], mergedCache = {};
      for (const v of Object.values(g.variants)) {
        const out = await gatherRecipe(page, mskuId, v.target, v.subs);
        if (!rec) rec = out.rec; // header (name/skuCode/allergens) same recipe regardless of variant
        allSubs = allSubs.concat(out.subs.filter(s => s.wo && newSet.has(s.wo)));
        Object.assign(mergedCache, out.cache);
      }
      const html = buildHtml(rec, allSubs, mergedCache, `RUN ${runN}`);
      const safe = (g.recName + ' - Run ' + runN).replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
      // Route output to the correct KW subfolder (e.g. KW 34) derived from the production date in the CSV.
      const kw = kwFromDateStr(g.date);
      const kwDir = path.join(CONFIG.outDir, `KW ${kw}`);
      fs.mkdirSync(kwDir, { recursive: true });
      const outFile = path.join(kwDir, safe + '.pdf');
      // Pre-save guard: if this exact PDF already exists in the KW folder, the run was already printed.
      // This can happen if the state file was reset or the bot ran twice. Skip to avoid duplicates.
      if (fs.existsSync(outFile)) {
        log('SKIP (already in KW folder):', outFile, '— mark WOs done and continue');
        newWOs.forEach(w => { if (!state.doneWO[w]) state.doneWO[w] = today; });
        state.runCount[g.recCode] = runN;
        continue;
      }
      await page.setContent(html, { waitUntil: 'load' });
      await page.pdf({ path: outFile, format: 'A4', printBackground: true, margin: { top: '9mm', bottom: '9mm', left: '9mm', right: '9mm' } });
      // Mark ONLY the new WOs done — do not overwrite already-done dates for old WOs in the same group.
      newWOs.forEach(w => state.doneWO[w] = today);
      state.runCount[g.recCode] = runN;
      made++; log('MADE:', safe, '→ KW', kw, '(' + newWOs.length + ' new WOs)');
    } catch (e) { log('ERROR on', g.recName, e.message); }
  }
  fs.writeFileSync(CONFIG.stateFile, JSON.stringify(state, null, 1));
  log('Done. Sheets generated:', made);
  await ctx.close();
}
main().catch(e => { log('FATAL', e); process.exit(1); });
