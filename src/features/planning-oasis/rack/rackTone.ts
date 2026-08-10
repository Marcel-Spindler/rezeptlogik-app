// Visuelle Einordnung fürs Rack-Board: Farben je Markt, Artikelart, Tier, Slot-Zweck.
import { deriveEntryKind, type RackEntry } from "../../../lib/rack";
import { rackV2SlotPurpose, type RackV2MarketId } from "../../../lib/rackV2";

export function marketChipTone(market: RackV2MarketId, active: boolean): string {
  if (!active) return "bg-white text-slate-600 ring-slate-300 hover:bg-slate-50";
  if (market === "DE") return "bg-emerald-600 text-white ring-emerald-700";
  if (market === "DKSE") return "bg-sky-600 text-white ring-sky-700";
  return "bg-orange-600 text-white ring-orange-700";
}

export function kindDot(entry: RackEntry): string {
  switch (deriveEntryKind(entry)) {
    case "meal": return "bg-emerald-500";
    case "ice": return "bg-cyan-500";
    case "loyalty": return "bg-amber-500";
    case "beverage": return "bg-fuchsia-500";
    case "protein": return "bg-rose-500";
    case "packaging": return "bg-slate-500";
    default: return "bg-violet-500";
  }
}

export function tierTone(tier: 1 | 2 | 3): string {
  if (tier === 2) return "bg-emerald-50 text-emerald-900 ring-emerald-200";
  if (tier === 1) return "bg-amber-50 text-amber-900 ring-amber-200";
  return "bg-slate-100 text-slate-700 ring-slate-300";
}

export function blockTone(active: boolean): string {
  return active ? "bg-emerald-50 text-emerald-900 ring-emerald-200" : "bg-rose-50 text-rose-800 ring-rose-200";
}

export function slotPurposeTone(purpose: ReturnType<typeof rackV2SlotPurpose>): string {
  switch (purpose) {
    case "meal": return "border-orange-300 bg-orange-50";
    case "ice": return "border-sky-300 bg-sky-50";
    case "smoothie": return "border-emerald-300 bg-emerald-50";
    case "flyer": return "border-violet-300 bg-violet-50";
    case "gift": return "border-blue-400 bg-blue-50";
    case "emergency": return "border-rose-400 bg-rose-50";
    default: return "border-slate-300 bg-white";
  }
}

export function isPackagingLike(entry: RackEntry): boolean {
  return deriveEntryKind(entry) === "packaging";
}

export function buildBoardKey(slot: number, tier: 1 | 2 | 3): string {
  return `${slot}:${tier}`;
}
