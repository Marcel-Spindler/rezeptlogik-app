import type { DataBundle } from "./types";

type Props = {
  data: DataBundle;
  week: string;
};

export function WmsLiveView({ week }: Props): JSX.Element {
  return (
    <div className="card p-6">
      <h2 className="text-2xl font-black text-slate-800">WMS Live - Neuaufbau</h2>
      <p className="mt-2 text-sm text-slate-500">
        Keine Firebase-Daten, kein Cache und keine alte Tool-Ansicht aktiv. Snowflake-Zugang bleibt lokal fuer die neue Query vorbereitet.
      </p>
      <div className="mt-4 rounded-lg bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-600 ring-1 ring-slate-200">
        Aktuelle KW: {week}
      </div>
    </div>
  );
}

export default WmsLiveView;
