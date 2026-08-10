import { useMemo, useState } from "react";
import type { DetailedSubRecipe, Market, RecipeStructure } from "../../../core/types";
import { fmtIngName, recipeHue, MARKET_LABEL } from "../../../lib/helpers";

interface Props {
  code: string;
  structure?: RecipeStructure;
  market: Market;
  recipeName: string;
}

const TW = 220, TH = 62, TGX = 72, TGY = 14, TPAD = 32;

const CATEGORY_COLOR: Record<string, string> = {
  GRILL: "bg-rose-100 text-rose-800 border-rose-300",
  OVEN: "bg-orange-100 text-orange-800 border-orange-300",
  BRAISER: "bg-amber-100 text-amber-800 border-amber-300",
  BRINE: "bg-cyan-100 text-cyan-800 border-cyan-300",
  MARINADE: "bg-violet-100 text-violet-800 border-violet-300",
  "BLAST CHILLER": "bg-sky-100 text-sky-800 border-sky-300",
  "PLANETARY MIXER": "bg-emerald-100 text-emerald-800 border-emerald-300",
  "HAND MIX": "bg-lime-100 text-lime-800 border-lime-300",
  "IMMERSION BLENDER": "bg-teal-100 text-teal-800 border-teal-300",
  STAGING: "bg-slate-100 text-slate-700 border-slate-300",
};

function categoryBadges(categories: string) {
  if (!categories) return null;
  const cats = categories.split(/[,/]/).map(s => s.trim()).filter(Boolean);
  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {cats.map(c => {
        const cls = Object.entries(CATEGORY_COLOR).find(([k]) => c.toUpperCase().includes(k))?.[1] ?? "bg-slate-100 text-slate-600 border-slate-200";
        return <span key={c} className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${cls}`}>{c}</span>;
      })}
    </div>
  );
}

function IngredientRow({ ing }: { ing: DetailedSubRecipe["ingredients"][number] }) {
  return (
    <div className="flex items-start gap-2 py-1 border-b border-dashed border-slate-100 last:border-0">
      <span className="mt-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-400 w-7 shrink-0">ING</span>
      <div className="flex-1 min-w-0">
        <div className="text-xs text-slate-700 font-medium truncate">{fmtIngName(ing.name)}</div>
        <div className="text-[10px] text-slate-400 tabular-nums">
          {ing.grossQty > 0 ? `Brutto ${ing.grossQty} ${ing.uom}` : ""}
          {ing.netQty > 0 && ing.netQty !== ing.grossQty ? ` / Netto ${ing.netQty}` : ""}
          {ing.allergen ? ` · ⚠ ${ing.allergen}` : ""}
        </div>
      </div>
    </div>
  );
}

function countIngredients(node: DetailedSubRecipe): number {
  return node.ingredients.length + node.subRecipes.reduce((s, c) => s + countIngredients(c), 0);
}

function collectIds(nodes: DetailedSubRecipe[], into: Set<string>) {
  for (const n of nodes) { into.add(n.id || n.name); collectIds(n.subRecipes, into); }
}

function SubRecipeNode({ node, depth }: { node: DetailedSubRecipe; depth: number }) {
  const [open, setOpen] = useState(true);
  const hasChildren = node.subRecipes.length > 0 || node.ingredients.length > 0;
  const totalIng = countIngredients(node);
  const borderCols = ["border-l-indigo-400", "border-l-violet-400", "border-l-fuchsia-400", "border-l-rose-400"];
  const borderClass = borderCols[Math.min(depth, borderCols.length - 1)];
  return (
    <div className={`ml-${depth === 0 ? "0" : "5"} mt-2`}>
      <div className={`rounded-xl border border-slate-200 border-l-4 ${borderClass} bg-white shadow-sm`}>
        <button onClick={() => setOpen(o => !o)} className="w-full flex items-start gap-2 p-3 text-left">
          <span className={`mt-0.5 text-[9px] font-bold uppercase tracking-widest shrink-0 ${depth === 0 ? "text-indigo-500" : depth === 1 ? "text-violet-500" : "text-fuchsia-500"}`}>SUB{depth + 1}</span>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-slate-800 leading-snug">{node.name}</div>
            {categoryBadges(node.categories)}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {node.quantity != null && <span className="text-[11px] bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full tabular-nums">{node.quantity} {node.uom ?? ""}</span>}
            <span className="text-[10px] text-slate-400">{totalIng} Zutat{totalIng !== 1 ? "en" : ""}</span>
            <span className="text-slate-400 text-xs">{open ? "▾" : "▸"}</span>
          </div>
        </button>
        {open && hasChildren && (
          <div className="border-t border-slate-100 px-3 pb-3 pt-2">
            {node.ingredients.length > 0 && (
              <div className="mb-2 rounded-lg bg-slate-50 px-2 py-1">
                {node.ingredients.map((ing, i) => <IngredientRow key={i} ing={ing} />)}
              </div>
            )}
            {node.subRecipes.map((sub, i) => <SubRecipeNode key={sub.id || i} node={sub} depth={depth + 1} />)}
          </div>
        )}
      </div>
    </div>
  );
}

interface FlatTreeNode {
  id: string; label: string; categories: string; ingCount: number; depth: number;
  cx: number; cy: number; parentId: string | null; hasChildren: boolean; expanded: boolean;
  node: DetailedSubRecipe;
}

function subtreeLeafCount(nodes: DetailedSubRecipe[], expanded: Set<string>): number {
  return nodes.reduce((s, n) => {
    const id = n.id || n.name;
    return s + (expanded.has(id) && n.subRecipes.length > 0 ? subtreeLeafCount(n.subRecipes, expanded) : 1);
  }, 0);
}

function buildFlatTree(roots: DetailedSubRecipe[], expanded: Set<string>): FlatTreeNode[] {
  const result: FlatTreeNode[] = [];
  function layout(nodes: DetailedSubRecipe[], depth: number, leafStart: number, parentId: string | null): number {
    let li = leafStart;
    for (const node of nodes) {
      const id = node.id || node.name;
      const isExpanded = expanded.has(id) && node.subRecipes.length > 0;
      const leaves = isExpanded ? subtreeLeafCount(node.subRecipes, expanded) : 1;
      result.push({
        id, label: node.name, categories: node.categories ?? "", ingCount: node.ingredients.length,
        depth, cx: TPAD + depth * (TW + TGX), cy: TPAD + (li + (leaves - 1) / 2) * (TH + TGY),
        parentId, hasChildren: node.subRecipes.length > 0, expanded: isExpanded, node,
      });
      li = isExpanded ? layout(node.subRecipes, depth + 1, li, id) : li + 1;
    }
    return li;
  }
  layout(roots, 0, 0, null);
  return result;
}

function TreeCanvas({ roots, code }: { roots: DetailedSubRecipe[]; code: string }) {
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const all = new Set<string>();
    collectIds(roots, all);
    return all;
  });
  const [hover, setHover] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const flatNodes = useMemo(() => buildFlatTree(roots, expanded), [roots, expanded]);
  const maxDepth = flatNodes.reduce((m, n) => Math.max(m, n.depth), 0);
  const maxLeaf = flatNodes.reduce((m, n) => Math.max(m, n.cy + TH / 2 + TPAD), 0);
  const svgW = TPAD * 2 + (maxDepth + 1) * (TW + TGX) - TGX;
  const svgH = maxLeaf;
  const hue = recipeHue(code);

  function toggleNode(id: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function collapseAll() { setExpanded(new Set()); }
  function expandAll() {
    const all = new Set<string>();
    collectIds(roots, all);
    setExpanded(all);
  }

  const nodeById = new Map(flatNodes.map(n => [n.id, n]));
  const selectedNode = selected ? nodeById.get(selected) : null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 items-center">
        <button onClick={expandAll} className="btn text-xs">Alle aufklappen</button>
        <button onClick={collapseAll} className="btn text-xs">Alle einklappen</button>
        <span className="text-xs text-slate-500">{flatNodes.length} Sub-Rezepte · {flatNodes.reduce((s, n) => s + n.ingCount, 0)} Zutaten gesamt</span>
      </div>
      <div className="overflow-auto rounded-2xl border border-slate-200 bg-white shadow-sm" style={{ maxHeight: "60vh" }}>
        <svg width={svgW} height={svgH} style={{ minWidth: svgW }}>
          {flatNodes.map(node => {
            const parent = node.parentId ? nodeById.get(node.parentId) : null;
            if (!parent) return null;
            const x1 = parent.cx + TW;
            const y1 = parent.cy + TH / 2;
            const x2 = node.cx;
            const y2 = node.cy + TH / 2;
            const mx = (x1 + x2) / 2;
            return (
              <path key={`edge-${node.id}`} d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}
                fill="none" stroke={`hsl(${hue} 40% 74%)`} strokeWidth="1.5" opacity="0.8" />
            );
          })}
          {flatNodes.map(node => {
            const isHover = hover === node.id;
            const isSel = selected === node.id;
            const cats = node.categories.split(/[,/]/).map(s => s.trim()).filter(Boolean);
            const mainCat = cats[0] ?? "";
            const catEntry = Object.entries(CATEGORY_COLOR).find(([k]) => mainCat.toUpperCase().includes(k));
            return (
              <foreignObject key={node.id} x={node.cx} y={node.cy} width={TW} height={TH}
                style={{ cursor: node.hasChildren ? "pointer" : "default" }}
                onClick={() => { if (node.hasChildren) toggleNode(node.id); setSelected(isSel ? null : node.id); }}
                onMouseEnter={() => setHover(node.id)} onMouseLeave={() => setHover(null)}>
                <div className={`h-full w-full rounded-xl border text-xs flex flex-col justify-center px-2 py-1 transition-all ${
                  isSel ? "shadow-md ring-2" : isHover ? "shadow-sm ring-1" : "shadow-sm"
                }`} style={{
                  borderColor: isSel ? `hsl(${hue} 70% 46%)` : isHover ? `hsl(${hue} 52% 62%)` : `hsl(${hue} 40% 78%)`,
                  background: isSel ? `hsl(${hue} 78% 92%)` : isHover ? `hsl(${hue} 60% 96%)` : `hsl(${hue} 38% 97%)`,
                }}>
                  <div className="font-semibold text-slate-800 truncate leading-tight" title={node.label}>{node.label}</div>
                  {catEntry && <span className={`mt-0.5 self-start rounded px-1 text-[9px] font-semibold border ${catEntry[1]}`}>{mainCat}</span>}
                  <div className="mt-0.5 text-[9px] text-slate-400 flex items-center gap-1">
                    <span>{node.ingCount} Zut.</span>
                    {node.hasChildren && <span>{node.expanded ? "▾" : "▸"} {node.node.subRecipes.length} Sub</span>}
                  </div>
                </div>
              </foreignObject>
            );
          })}
        </svg>
      </div>
      {selectedNode && (
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm text-sm space-y-2">
          <div className="font-semibold text-slate-800">{selectedNode.label}</div>
          {categoryBadges(selectedNode.categories)}
          {selectedNode.node.ingredients.length > 0 && (
            <div className="rounded-lg bg-slate-50 px-2 py-1 divide-y divide-slate-100">
              {selectedNode.node.ingredients.map((ing, i) => <IngredientRow key={i} ing={ing} />)}
            </div>
          )}
          {selectedNode.node.ingredients.length === 0 && <div className="text-slate-400">Keine direkten Zutaten.</div>}
        </div>
      )}
    </div>
  );
}

export function StructureTab({ code, structure, market, recipeName }: Props) {
  const [treeMode, setTreeMode] = useState<"svg" | "list">("svg");

  if (!structure) {
    return (
      <div className="card p-4 text-slate-500">
        <div className="font-semibold mb-1">Kein Detailed-Export für {code} vorhanden.</div>
        <div className="text-xs">Exportiere <code>export-sub-recipes-by-recipe-detailed.csv</code> und führe <code>npm run import:gsheet</code> aus.</div>
      </div>
    );
  }

  const roots = structure.markets[market] ?? [];

  return (
    <div className="space-y-3">
      <div className="card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-slate-700">{recipeName} — Rezeptbaum</h3>
            <div className="text-xs text-slate-500 mt-0.5">{roots.length} Top-Level-Sub-Rezepte · Markt: {MARKET_LABEL[market]}</div>
          </div>
          <div className="flex gap-2">
            <button onClick={() => setTreeMode("svg")} className={`btn text-xs ${treeMode === "svg" ? "bg-slate-900 text-white" : ""}`}>SVG-Baum</button>
            <button onClick={() => setTreeMode("list")} className={`btn text-xs ${treeMode === "list" ? "bg-slate-900 text-white" : ""}`}>Liste</button>
          </div>
        </div>
      </div>
      {treeMode === "svg" && roots.length > 0 && <TreeCanvas roots={roots} code={code} />}
      {treeMode === "list" && roots.map((sub, i) => <SubRecipeNode key={sub.id || i} node={sub} depth={0} />)}
      {roots.length === 0 && <div className="card p-4 text-slate-500">Keine Sub-Rezepte im Detailed Export für dieses Rezept.</div>}
    </div>
  );
}
