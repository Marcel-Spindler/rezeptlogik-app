// Darstellungs-Bausteine der Linienplanung: Rezept-Pille (Pool + Board), Drop-Zelle,
// Mengen-Balken. Rein präsentational, State/Handler kommen als Props von außen.
import { useState } from "react";
import type { RampUpSnapshot } from "../../../lib/rampUpHistory";
import {
  collisionPillTone, fmtNum, lineRunTargetsForRecipe, nameShort, planningRoleLabel,
  planningRoleTone, recipeHue, recipeTone, runBadgeTone,
} from "./linePlanningLogic";
import { DAY_SHORT, type LineCollisionHint, type LinePlanRecipe } from "./linePlanningDomain";

export function Sparkline({ values, width = 60, height = 16 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const pad = 2;
  const pts = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (width - pad * 2);
    const y = pad + ((max - v) / range) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const last = values[values.length - 1];
  const first = values[0];
  const stroke = last > first ? "#10b981" : last < first ? "#f43f5e" : "#94a3b8";
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="shrink-0">
      <polyline points={pts} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.85" />
      <circle cx={pts.split(" ").pop()!.split(",")[0]} cy={pts.split(" ").pop()!.split(",")[1]} r="2" fill={stroke} />
    </svg>
  );
}

export function DeltaBadge({ delta }: { delta: number }) {
  if (delta === 0) return null;
  const up = delta > 0;
  return (
    <span className={`text-[9px] font-bold tabular-nums px-1 rounded-full ring-1 ${
      up ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : "bg-rose-50 text-rose-700 ring-rose-200"
    }`}>
      {up ? "+" : ""}{fmtNum(delta)}
    </span>
  );
}

export function RecipePill({
  recipe, compact = false, dimmed = false,
  scheduledDays,
  scheduledPortions,
  planningRole,
  multiDayCount,
  mhdViolation,
  collisions = [],
  onDragStart,
  volumeHistory,
  volumeDelta,
  volumeSnapshots,
}: {
  recipe: LinePlanRecipe;
  compact?: boolean;
  dimmed?: boolean;
  scheduledDays?: string[];
  scheduledPortions?: number;
  planningRole?: "factory" | "hybrid" | "supplied";
  multiDayCount?: number;
  mhdViolation?: boolean;
  collisions?: LineCollisionHint[];
  onDragStart?: () => void;
  volumeHistory?: number[];
  volumeDelta?: number;
  volumeSnapshots?: RampUpSnapshot[];
}) {
  const [hovered, setHovered] = useState(false);
  if (recipe.isBreak) {
    return (
      <div className={`rounded-xl border border-amber-300 bg-amber-50 ring-1 ring-amber-200/60 select-none ${compact ? "px-2 py-1.5" : "px-3 py-2.5"}`}>
        <div className="flex items-center gap-1.5">
          <span className="text-sm">🧹</span>
          <span className="font-bold text-xs text-amber-700">Pause – Reinigung & Zählung</span>
        </div>
        <div className="text-[10px] text-amber-500 mt-0.5">1 Stunde · Rezeptwechsel</div>
      </div>
    );
  }

  const tone = recipeTone(recipe.code);
  const style = tone.base;
  const runTargets = lineRunTargetsForRecipe(recipe);
  const targetTotal = runTargets.totalTarget;
  const pct = targetTotal > 0 && scheduledPortions !== undefined ? scheduledPortions / targetTotal : 0;
  const fullyPlanned = pct >= 1;
  const overPlanned = pct > 1.02;
  const worstCollision = collisions.find(item => item.severity === "error") ?? collisions[0];
  return (
    <div className="relative" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <div
        draggable
        onDragStart={e => { e.dataTransfer.effectAllowed = "move"; onDragStart?.(); }}
        onDragOver={e => e.preventDefault()}
        style={style}
        className={`rounded-xl cursor-grab active:cursor-grabbing select-none transition-all duration-150 ${
          dimmed ? "opacity-40" : "hover:shadow-md hover:scale-[1.02]"
        } ${compact ? "px-2 py-1.5" : "px-3 py-2.5"}`}
      >
        {compact ? (
          <div className="flex flex-col gap-0.5 min-w-0">
            <div className="flex items-center gap-1">
              <span className="font-bold text-xs shrink-0" style={tone.code}>{recipe.code}</span>
              {recipe.isSeafood
                ? <span className="rounded-full px-1.5 py-0 text-[9px] font-bold bg-blue-100 text-blue-700 ring-1 ring-blue-200">🐟 9d</span>
                : <span className="rounded-full px-1.5 py-0 text-[9px] font-bold bg-slate-100 text-slate-500 ring-1 ring-slate-200">13d</span>
              }
              {worstCollision && (
                <span className={`rounded-full px-1.5 py-0 text-[9px] font-black ring-1 ${collisionPillTone(worstCollision.severity)}`} title={worstCollision.message}>
                  !
                </span>
              )}
            </div>
            <span className="text-[11px] font-medium leading-tight line-clamp-2" style={tone.title}>{recipe.name.replace(/^FV\d+[A-Za-z]?\s*[-–]\s*/i, "")}</span>
            <div className="flex items-center gap-1">
              <span className="text-[10px] opacity-50 tabular-nums">{fmtNum(targetTotal)} Port.</span>
              {volumeDelta !== undefined && volumeDelta !== 0 && <DeltaBadge delta={volumeDelta} />}
            </div>
            {volumeHistory && volumeHistory.length >= 2 && (
              <div className="mt-1 flex items-center gap-2">
                <Sparkline values={volumeHistory} width={40} height={12} />
                <span className="text-[9px] text-slate-400 tabular-nums">{fmtNum(volumeHistory[0])} → {fmtNum(volumeHistory[volumeHistory.length - 1])}</span>
              </div>
            )}
          </div>
        ) : (
          <div className="min-w-0">
            <div className="flex items-center justify-between gap-2 mb-0.5">
              <div className="flex items-center gap-1.5">
                <span className="font-bold text-sm tracking-tight" style={tone.code}>{recipe.code}</span>
                {recipe.isSeafood
                  ? <span className="rounded-full px-2 py-0.5 text-[10px] font-bold bg-blue-100 text-blue-700 ring-1 ring-blue-200">🐟 9d</span>
                  : <span className="rounded-full px-2 py-0.5 text-[10px] font-semibold bg-slate-100 text-slate-500 ring-1 ring-slate-200">13d</span>
                }
                {worstCollision && (
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-black ring-1 ${collisionPillTone(worstCollision.severity)}`} title={worstCollision.message}>
                    Kollision
                  </span>
                )}
              </div>
              <span className="text-xs opacity-60 tabular-nums">{recipe.speedPerMin}/min</span>
            </div>
            <div className="text-xs font-medium truncate mb-2" style={tone.title}>{nameShort(recipe.name, 34)}</div>
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs opacity-70 tabular-nums">
              {recipe.nordics > 0 && <span>&#x2B21; NORD {fmtNum(recipe.nordics)}</span>}
              {recipe.de > 0 && <span>&#x2B21; DE {fmtNum(recipe.de)}</span>}
              {recipe.bnl > 0 && <span>&#x2B21; BNL {fmtNum(recipe.bnl)}</span>}
            </div>
            <div className="mt-1.5 flex items-center gap-2">
              <span className="text-xs font-semibold tabular-nums">&#x2211; {fmtNum(targetTotal)} Portionen · R1 {fmtNum(runTargets.firstRunTarget)} / R2 {fmtNum(runTargets.secondRunTarget)}</span>
              {volumeDelta !== undefined && volumeDelta !== 0 && <DeltaBadge delta={volumeDelta} />}
            </div>
            {volumeHistory && volumeHistory.length >= 2 && (
              <div className="mt-1.5 flex items-center gap-2">
                <Sparkline values={volumeHistory} width={60} height={16} />
                <span className="text-[10px] text-slate-400 tabular-nums">{fmtNum(volumeHistory[0])} → {fmtNum(volumeHistory[volumeHistory.length - 1])}</span>
              </div>
            )}
            <div className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ${planningRoleTone(planningRole)}`}>
              {planningRoleLabel(planningRole)}
            </div>
            {scheduledDays && scheduledDays.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1 items-center">
                {overPlanned && <span className="text-[10px] font-bold text-rose-600">&#x26A0; überplant</span>}
                {!overPlanned && fullyPlanned && <span className="text-[10px] font-bold text-emerald-700">&#x2713; fertig</span>}
                {scheduledDays.map(d => (
                  <span key={d} className={`rounded-full px-2 py-0.5 text-[10px] font-bold ring-1 ${
                    overPlanned ? "bg-rose-50 text-rose-700 ring-rose-300"
                    : fullyPlanned ? "bg-emerald-50 text-emerald-700 ring-emerald-300"
                    : "bg-white/70 text-slate-700 ring-slate-300"
                  }`}>
                    {DAY_SHORT[d] ?? d}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      {hovered && (
        <div className={`absolute ${compact ? "bottom-full mb-1" : "top-full mt-1"} left-0 z-[300] w-72 rounded-2xl bg-white shadow-2xl ring-1 ring-slate-200 p-4 pointer-events-none select-none`}>
          <div className="mb-3 flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-2">
              <span className="font-black text-base" style={tone.code}>{recipe.code}</span>
              <span className="font-semibold text-slate-700 text-xs leading-tight mt-0.5">{recipe.name}</span>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              {mhdViolation && (
                <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-black text-orange-700 ring-1 ring-orange-200">MHD</span>
              )}
              {worstCollision && (
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-black ring-1 ${collisionPillTone(worstCollision.severity)}`}>Kollision</span>
              )}
              {multiDayCount && multiDayCount > 1 && (
                <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-black text-indigo-700 ring-1 ring-indigo-200">{multiDayCount} Tage</span>
              )}
              {overPlanned && (
                <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-black text-rose-700 ring-1 ring-rose-200">überplant</span>
              )}
              {!overPlanned && fullyPlanned && (
                <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-black text-emerald-700 ring-1 ring-emerald-200">fertig</span>
              )}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 mb-3">
            {recipe.nordics > 0 && (
              <div className="rounded-lg bg-slate-50 px-2 py-1.5 text-center ring-1 ring-slate-100">
                <div className="text-[10px] text-slate-400 uppercase tracking-wide font-semibold">Nordics</div>
                <div className="font-bold text-xs text-slate-800 tabular-nums">{fmtNum(recipe.nordics)}</div>
              </div>
            )}
            {recipe.de > 0 && (
              <div className="rounded-lg bg-slate-50 px-2 py-1.5 text-center ring-1 ring-slate-100">
                <div className="text-[10px] text-slate-400 uppercase tracking-wide font-semibold">DE</div>
                <div className="font-bold text-xs text-slate-800 tabular-nums">{fmtNum(recipe.de)}</div>
              </div>
            )}
            {recipe.bnl > 0 && (
              <div className="rounded-lg bg-slate-50 px-2 py-1.5 text-center ring-1 ring-slate-100">
                <div className="text-[10px] text-slate-400 uppercase tracking-wide font-semibold">BNL</div>
                <div className="font-bold text-xs text-slate-800 tabular-nums">{fmtNum(recipe.bnl)}</div>
              </div>
            )}
          </div>
          {collisions.length > 0 && (
            <div className="mb-3 space-y-1 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] text-rose-900">
              {collisions.slice(0, 3).map(item => (
                <div key={item.key}>
                  <span className="font-black">{item.location}:</span> {item.message}
                </div>
              ))}
            </div>
          )}
          <div className="flex items-center justify-between text-xs mb-2 pb-2 border-b border-slate-100">
            <span className="text-slate-500">&#x2211; Geplant</span>
            <span className="font-bold tabular-nums text-slate-800">{fmtNum(targetTotal)} Port.</span>
            {recipe.speedPerMin > 0 && <span className="font-bold tabular-nums text-indigo-600 ml-3">{recipe.speedPerMin}/min</span>}
          </div>
          {scheduledPortions !== undefined && scheduledPortions > 0 && (
            <div className="mb-2">
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="text-slate-500">Eingeplant</span>
                <span className={`font-bold tabular-nums ${overPlanned ? "text-rose-600" : fullyPlanned ? "text-emerald-600" : "text-slate-700"}`}>
                  {fmtNum(scheduledPortions)} · {Math.round(pct * 100)}%
                </span>
              </div>
              <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
                <div className={`h-full rounded-full ${overPlanned ? "bg-rose-400" : fullyPlanned ? "bg-emerald-400" : "bg-indigo-400"}`} style={{ width: `${Math.min(100, pct * 100)}%` }} />
              </div>
            </div>
          )}
          {scheduledDays && scheduledDays.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-2 border-t border-slate-100 mt-1">
              <span className="text-[10px] text-slate-400 font-semibold w-full mb-0.5">Eingeplant an:</span>
              {scheduledDays.map(d => (
                <span key={d} className={`rounded-full px-2 py-0.5 text-[10px] font-bold ring-1 ${
                  overPlanned ? "bg-rose-50 text-rose-700 ring-rose-300"
                  : fullyPlanned ? "bg-emerald-50 text-emerald-700 ring-emerald-300"
                  : "bg-slate-100 text-slate-600 ring-slate-200"
                }`}>{DAY_SHORT[d] ?? d}</span>
              ))}
            </div>
          )}
          {volumeSnapshots && volumeSnapshots.length >= 2 && (
            <div className="pt-2 border-t border-slate-100 mt-2">
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-[10px] text-slate-400 font-semibold">Portionen-Verlauf</span>
                <Sparkline values={volumeSnapshots.map(s => s.volumes[recipe.code] ?? 0)} width={50} height={14} />
              </div>
              <div className="flex flex-col gap-0.5">
                {volumeSnapshots.slice(-5).reverse().map((snap, idx) => {
                  const vol = snap.volumes[recipe.code] ?? 0;
                  const prev = volumeSnapshots[volumeSnapshots.indexOf(snap) - 1]?.volumes[recipe.code];
                  const delta = prev !== undefined ? vol - prev : 0;
                  return (
                    <div key={snap.ts} className={`flex items-center justify-between text-[10px] ${idx === 0 ? "font-semibold text-slate-700" : "text-slate-400"}`}>
                      <span className="tabular-nums">{snap.label}</span>
                      <span className="tabular-nums">{fmtNum(vol)}</span>
                      {delta !== 0 && <DeltaBadge delta={delta} />}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function DropCell({
  slotKey, recipe, isDragOver, isActiveDrag,
  onDrop, onDragEnter, onDragLeave,
  onDragStartCell, onRemove, multiDayCount, mhdViolation,
  collisions = [],
  volumeHistory, volumeDelta, volumeSnapshots,
}: {
  slotKey: string;
  recipe: LinePlanRecipe | null;
  isDragOver: boolean;
  isActiveDrag: boolean;
  onDrop: () => void;
  onDragEnter: () => void;
  onDragLeave: () => void;
  onDragStartCell: (r: LinePlanRecipe, key: string) => void;
  onRemove: () => void;
  multiDayCount?: number;
  /** true wenn das Rezept in diesem Slot zu früh geplattet wird (MHD-Verletzung) */
  mhdViolation?: boolean;
  collisions?: LineCollisionHint[];
  volumeHistory?: number[];
  volumeDelta?: number;
  volumeSnapshots?: RampUpSnapshot[];
}) {
  const worstCollision = collisions.find(item => item.severity === "error") ?? collisions[0];
  return (
    <div
      onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; onDragEnter(); }}
      onDragEnter={e => { e.preventDefault(); onDragEnter(); }}
      onDragLeave={onDragLeave}
      onDrop={e => { e.preventDefault(); onDrop(); }}
      className={`min-h-[5rem] rounded-xl border-2 transition-all duration-100 flex items-stretch ${
        recipe?.isBreak
          ? "border-amber-200 bg-amber-50/60"
          : isDragOver
          ? "border-indigo-400 bg-indigo-50 ring-2 ring-indigo-300/50 scale-[1.03]"
          : worstCollision
          ? `${worstCollision.severity === "error" ? "border-rose-500 bg-rose-50/60 ring-1 ring-rose-300/70" : "border-amber-400 bg-amber-50/60 ring-1 ring-amber-300/70"}`
          : mhdViolation
          ? "border-orange-400 bg-orange-50/40 ring-1 ring-orange-300/50"
          : recipe
          ? "border-transparent"
          : isActiveDrag
          ? "border-dashed border-indigo-200 bg-indigo-50/30"
          : "border-dashed border-slate-200 bg-slate-50/50 hover:border-slate-300 hover:bg-slate-50"
      }`}
    >
      {recipe ? (
        <div className="relative w-full group p-0.5" onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }}>
          <RecipePill
            recipe={recipe}
            compact
            multiDayCount={multiDayCount}
            mhdViolation={mhdViolation}
            collisions={collisions}
            onDragStart={() => onDragStartCell(recipe, slotKey)}
            volumeHistory={volumeHistory}
            volumeDelta={volumeDelta}
            volumeSnapshots={volumeSnapshots}
          />
          {worstCollision && (
            <div className={`mt-1 rounded-lg px-2 py-1 text-[10px] font-semibold ring-1 ${collisionPillTone(worstCollision.severity)}`} title={worstCollision.action}>
              {worstCollision.message}
            </div>
          )}
          <button
            onClick={onRemove}
            className="absolute -top-1 -right-1 hidden group-hover:flex h-4 w-4 items-center justify-center rounded-full bg-slate-700 text-white text-[10px] font-bold leading-none hover:bg-red-500 transition-colors z-10"
            title="Entfernen"
          >x</button>
        </div>
      ) : (
        <div className={`w-full flex items-center justify-center text-slate-300 text-sm transition-opacity ${
          isDragOver ? "opacity-0" : isActiveDrag ? "opacity-70" : "opacity-40"
        }`}>
          {isActiveDrag ? "Ablegen" : "-"}
        </div>
      )}
    </div>
  );
}

export function VolumeBar({ recipe, scheduledPortions }: { recipe: LinePlanRecipe; scheduledPortions: number }) {
  const runTargets = lineRunTargetsForRecipe(recipe);
  const targetTotal = runTargets.totalTarget;
  const pct = targetTotal > 0 ? Math.min(100, (scheduledPortions / targetTotal) * 100) : 0;
  const h = recipeHue(recipe.code);
  const over = scheduledPortions > targetTotal;
  return (
    <div className="rounded-xl border border-slate-100 bg-white p-3 shadow-sm">
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="min-w-0">
          <div className="font-bold text-xs" style={{ color: `hsl(${h},52%,22%)` }}>{recipe.code}</div>
          <div className="text-xs text-slate-500 truncate">{nameShort(recipe.name, 26)}</div>
        </div>
        <div className="text-right shrink-0">
          <div className={`text-sm font-bold tabular-nums ${over ? "text-rose-600" : pct >= 100 ? "text-emerald-600" : "text-slate-700"}`}>
            {Math.round(pct)}%
          </div>
          <div className="mt-0.5 text-[10px] text-slate-400 tabular-nums">{fmtNum(scheduledPortions)}/{fmtNum(targetTotal)}</div>
          <div className="mt-1 flex items-center justify-end gap-1">
            <span className={`rounded-full border px-1.5 py-0.5 text-[9px] font-black ${runBadgeTone(1)}`}>R1 {fmtNum(runTargets.firstRunTarget)}</span>
            <span className={`rounded-full border px-1.5 py-0.5 text-[9px] font-black ${runBadgeTone(2)}`}>R2 {fmtNum(runTargets.secondRunTarget)}</span>
          </div>
        </div>
      </div>
      <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(100, pct)}%`, background: over ? `hsl(0,75%,60%)` : `hsl(${h},55%,60%)` }} />
      </div>
      {over && <div className="text-[10px] text-rose-500 mt-1">+{fmtNum(scheduledPortions - targetTotal)} überplant</div>}
    </div>
  );
}
