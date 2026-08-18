// Gather recipe data for W33 new WOs via MSKU API (Node.js fetch, Bearer token from env)
// Usage: MSKU_TOKEN=<token> node gather-w33.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { classify, READY_MADE } from './capacity-rules.js';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'https://operations.hellofresh.com';
const BRAND = 'Factor';
const MARKET = 'eu';
const TOKEN = process.env.MSKU_TOKEN;
if (!TOKEN) { console.error('Set MSKU_TOKEN env var'); process.exit(1); }

async function api(url, opts = {}) {
  const r = await fetch(url, {
    method: opts.method || 'GET',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN },
    body: opts.body
  });
  if (!r.ok && r.status !== 200) console.warn('HTTP', r.status, url.slice(0, 80));
  return { status: r.status, json: await r.json().catch(() => null) };
}

const gramsOf = a => Array.isArray(a) ? (a.find(x => x.unitOfMeasure === 'grams')?.count ?? null) : (typeof a === 'number' ? a : null);

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
const alg = a => a ? { c: (a.allergens || []).map(x => biAllergen(x.name)) } : { c: [] };

const gv = a => (typeof a === 'number' ? a : gramsOf(a));
const childrenOf = i => { const kids = []; (i.manufacturingProcess?.paths || []).forEach(p => (p.kitchenStations || []).forEach(ks => (ks.billOfMaterials || []).forEach(c => kids.push(mkNode(c))))); return kids; };
const mkNode = i => ({ name: i.name, g: gv(i.totalAmount), manuf: i.isManufactured, id: i.id, children: childrenOf(i) });
const collectManufIds = (nodes, acc) => { nodes.forEach(n => { if (n.manuf && n.id && !READY_MADE.test(n.name)) { acc.add(n.id); collectManufIds(n.children, acc); } }); return acc; };

function matchWO(subName, woMap) {
  const n = (subName || '').toLowerCase();
  for (const [csvName, wo] of Object.entries(woMap)) {
    const c = csvName.toLowerCase();
    if (c && (n.includes(c.slice(0, 18)) || c.includes(n.slice(0, 18)))) return wo;
  }
  return null;
}

async function resolveMskuId(recCode, recName) {
  for (const sv of [recCode, recName]) {
    const r = (await api(`${BASE}/gw/scm/manufactured-sku-service/manufactured-skus?limit=25&offset=0&searchValue=${encodeURIComponent(sv)}&brand=${BRAND}&market=${MARKET}`)).json;
    const item = (r?.items || []).find(x => x.code === recCode) || (r?.items || [])[0];
    if (item) return item.id;
  }
  return null;
}

async function gatherRecipe(mskuId, portions, woByCsvSubName) {
  const det = (await api(`${BASE}/gw/scm/manufactured-sku-service/v4/manufactured-skus/${mskuId}?brand=${BRAND}&market=${MARKET}`)).json;
  const subDetails = (det.billOfMaterials || []).map(b => {
    const { rti, capacityKg, unit } = classify(b.name, b.cookMethods || []);
    const wo = matchWO(b.name, woByCsvSubName);
    return { subRecipeId: b.skuId, name: b.name, rti, equipmentName: wo || '', maxEquipmentCapacityAmount: capacityKg ?? 10000, maxEquipmentCapacityUnit: unit };
  });
  const body = JSON.stringify([{ id: mskuId, portions, sourceLocation: 'BULK_VIEW', subRecipeDetails: subDetails.filter(s => !s.rti).map(({ subRecipeId, equipmentName, maxEquipmentCapacityAmount, maxEquipmentCapacityUnit }) => ({ subRecipeId, equipmentName, maxEquipmentCapacityAmount, maxEquipmentCapacityUnit })) }]);
  const traceId = crypto.randomUUID();
  const res = (await api(`${BASE}/gw/scm/manufactured-sku-service/v2/bulk/pdf-export?traceId=${traceId}`, { method: 'POST', body })).json;
  const rec0 = (Array.isArray(res) ? res : [res])[0];
  if (!rec0) throw new Error('pdf-export returned empty response');
  const rec = { name: rec0.name, skuCode: rec0.skuCode, totalPortions: rec0.totalPortions, alg: alg(rec0.allergenData) };
  const subs = []; (rec0.primaryPackaging?.compartmentData || []).forEach(c => (c.billOfMaterials || []).forEach(b => subs.push(b)));
  const cache = {};
  const instrOnly = async id => {
    if (!id || cache[id]) return;
    cache[id] = { en: '', de: '' };
    try {
      const d = (await api(`${BASE}/gw/scm/manufactured-sku-service/v4/manufactured-skus/${id}?brand=${BRAND}&market=${MARKET}`)).json;
      cache[id] = { en: d.instructions?.find(i => i.language === 'English')?.instruction || '', de: d.instructions?.find(i => i.language === 'German')?.instruction || '' };
    } catch {}
  };
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

const groups = JSON.parse(fs.readFileSync(path.join(__dir, 'groups-new-w33.json'), 'utf8'));
const gatheredDir = path.join(__dir, 'gathered');
fs.mkdirSync(gatheredDir, { recursive: true });

for (const g of groups) {
  const safeDateStr = g.date.replace(/[^0-9a-zA-Z-]/g, '_');
  const outFile = path.join(gatheredDir, `gather-w33-${g.recCode}-${safeDateStr}.json`);
  if (fs.existsSync(outFile)) { console.log('SKIP (exists):', g.recCode); continue; }
  console.log(`Gathering ${g.recCode} (${g.recName}, target=${g.target})...`);
  try {
    const mskuId = await resolveMskuId(g.recCode, g.recName);
    if (!mskuId) { console.error('  No mskuId found for:', g.recCode); continue; }
    console.log(`  mskuId: ${mskuId}`);
    const result = await gatherRecipe(mskuId, g.target, g.subs);
    fs.writeFileSync(outFile, JSON.stringify(result, null, 1));
    console.log(`  -> ${result.subs.length} subs, ${Object.keys(result.cache).length} cache entries`);
  } catch (e) { console.error('  ERROR:', e.message); }
}
console.log('Gathering complete.');
