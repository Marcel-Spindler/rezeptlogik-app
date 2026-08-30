// Header + Layout-Rahmen, den jede Oberfläche (voll, Kitchen Mode, Rundmail) teilt.
// `wide` (KET Plan / WO): sprengt den 1536px-Deckel, damit die drei Spalten
// (WO-Liste + Kochanweisungen + Breakdown) auf großen Monitoren Platz haben.
export function Shell({ children, wide = false, headerRight }: { children: React.ReactNode; wide?: boolean; headerRight?: React.ReactNode }) {
  const container = wide ? "max-w-[1920px]" : "max-w-screen-2xl";
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-30">
        <div className={`mx-auto ${container} px-4 py-3 flex items-center gap-3`}>
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-verden-600 flex items-center justify-center">
              <span className="text-white text-xs font-bold">F</span>
            </div>
            <div>
              <div className="text-sm font-bold tracking-tight text-slate-900 leading-none">Factor OPS Planner</div>
              <div className="text-[10px] text-slate-400 leading-none mt-0.5">Verden · Ramp-Up 2026</div>
            </div>
          </div>
          {headerRight && <div className="ml-auto flex items-center gap-2">{headerRight}</div>}
        </div>
      </header>
      <div className={`mx-auto ${container} px-4 py-4`}>{children}</div>
    </div>
  );
}

export function LoadingCard() {
  return (
    <Shell>
      <div className="card p-8 flex items-center gap-3 text-slate-500">
        <svg className="animate-spin w-5 h-5 text-verden-600" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        Lade Daten…
      </div>
    </Shell>
  );
}

export function ErrorCard({ message }: { message: string }) {
  return (
    <Shell>
      <div className="card p-6 text-red-700">
        <div className="font-semibold">Fehler beim Laden</div>
        <div className="mt-1 text-sm">{message}</div>
        <div className="mt-2 text-sm text-slate-500">
          Tipp: <code>npm run import:local</code> ausführen.
        </div>
      </div>
    </Shell>
  );
}
