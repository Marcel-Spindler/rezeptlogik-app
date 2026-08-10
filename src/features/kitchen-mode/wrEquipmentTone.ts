// Kitchen Mode / Breakdown – Farb-/Ton-Zuordnung für Equipment-Badges und Deckungs-Szenarien.

export function equipmentColorScheme(eq: string | null): {
  bg: string;
  headerBg: string;
  border: string;
  badge: string;
  text: string;
  icon: string;
} {
  if (!eq) return { bg: "bg-slate-50", headerBg: "bg-slate-100", border: "border-slate-300", badge: "bg-slate-200 text-slate-700", text: "text-slate-600", icon: "🍳" };
  const e = eq.toUpperCase();
  if (e.includes("BRAISER"))
    return { bg: "bg-orange-50", headerBg: "bg-gradient-to-r from-orange-100 to-amber-50", border: "border-orange-400", badge: "bg-orange-100 text-orange-800", text: "text-orange-800", icon: "🔥" };
  if (e.includes("MIDDLE-KITCHEN") || e.includes("VERIMIXER") || e.includes("PLANETARY") || e.includes("HOBART"))
    return { bg: "bg-violet-50", headerBg: "bg-gradient-to-r from-violet-100 to-purple-50", border: "border-violet-400", badge: "bg-violet-100 text-violet-800", text: "text-violet-800", icon: "🌀" };
  if (e.includes("VEGGIE-DEBOX") || e.includes("VEGGIE DEBOX"))
    return { bg: "bg-emerald-50", headerBg: "bg-gradient-to-r from-emerald-100 to-green-50", border: "border-emerald-400", badge: "bg-emerald-100 text-emerald-800", text: "text-emerald-800", icon: "🥦" };
  if (e.includes("PROTEIN-DEBOX") || e.includes("V-MAG") || e.includes("VMAG"))
    return { bg: "bg-sky-50", headerBg: "bg-gradient-to-r from-sky-100 to-blue-50", border: "border-sky-400", badge: "bg-sky-100 text-sky-800", text: "text-sky-800", icon: "🥩" };
  if (e.includes("OVEN"))
    return { bg: "bg-amber-50", headerBg: "bg-gradient-to-r from-amber-100 to-yellow-50", border: "border-amber-400", badge: "bg-amber-100 text-amber-800", text: "text-amber-800", icon: "♨️" };
  if (e.includes("BLAST"))
    return { bg: "bg-blue-50", headerBg: "bg-gradient-to-r from-blue-100 to-indigo-50", border: "border-blue-400", badge: "bg-blue-100 text-blue-800", text: "text-blue-800", icon: "❄️" };
  if (e.includes("IMMERSION") || e.includes("BLENDER"))
    return { bg: "bg-teal-50", headerBg: "bg-gradient-to-r from-teal-100 to-cyan-50", border: "border-teal-400", badge: "bg-teal-100 text-teal-800", text: "text-teal-800", icon: "💧" };
  return { bg: "bg-indigo-50", headerBg: "bg-gradient-to-r from-indigo-100 to-blue-50", border: "border-indigo-300", badge: "bg-indigo-100 text-indigo-800", text: "text-indigo-800", icon: "⚙️" };
}

export function wrScenarioTone(rawCoverage: number | null): {
  band: string;
  badge: string;
  meter: string;
  label: string;
} {
  if (rawCoverage == null) {
    return {
      band: "bg-slate-900 text-white ring-slate-700",
      badge: "bg-white/10 text-slate-100 ring-white/15",
      meter: "bg-slate-400",
      label: "Soll-Szenario"
    };
  }
  if (rawCoverage < 0.8) {
    return {
      band: "bg-rose-950 text-white ring-rose-800",
      badge: "bg-rose-400/15 text-rose-100 ring-rose-300/25",
      meter: "bg-rose-400",
      label: "Kritischer Engpass"
    };
  }
  if (rawCoverage < 1) {
    return {
      band: "bg-amber-950 text-white ring-amber-800",
      badge: "bg-amber-400/15 text-amber-100 ring-amber-300/25",
      meter: "bg-amber-400",
      label: "Teilabdeckung"
    };
  }
  return {
    band: "bg-emerald-950 text-white ring-emerald-800",
    badge: "bg-emerald-400/15 text-emerald-100 ring-emerald-300/25",
    meter: "bg-emerald-400",
    label: "Freigegeben"
  };
}

