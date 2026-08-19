import { useRedzoneOptional } from "./RedzoneContext";

export function LiveBadge({ recipeCode }: { recipeCode: string }) {
  const rz = useRedzoneOptional();
  if (!rz || !rz.isPlatingNow(recipeCode)) return null;

  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800 ring-1 ring-emerald-200 animate-pulse">
      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
      PLATING
    </span>
  );
}

export function LiveDot({ recipeCode }: { recipeCode: string }) {
  const rz = useRedzoneOptional();
  if (!rz || !rz.isPlatingNow(recipeCode)) return null;

  return (
    <span className="relative flex h-2 w-2 shrink-0" title="Wird gerade geplated">
      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
      <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
    </span>
  );
}

export function LiveCount() {
  const rz = useRedzoneOptional();
  if (!rz || rz.activeLineCount === 0) return null;

  return (
    <span className="relative flex h-2 w-2 shrink-0">
      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
      <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
    </span>
  );
}
