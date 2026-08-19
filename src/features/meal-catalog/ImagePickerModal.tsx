import { useEffect, useRef, useState } from "react";

interface FolderImage {
  name: string;
  score: number;
  label: string;
  url: string;
}

interface Props {
  mealId: string;
  currentUrl?: string;
  onSelect: (url: string) => void;
  onClose: () => void;
}

export function ImagePickerModal({ mealId, currentUrl, onSelect, onClose }: Props) {
  const [folderImages, setFolderImages] = useState<FolderImage[]>([]);
  const [localImages, setLocalImages] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    Promise.all([
      fetch(`/api/meal-folder-images/${mealId}`)
        .then(r => r.ok ? (r.json() as Promise<FolderImage[]>) : Promise.resolve([]))
        .catch(() => [] as FolderImage[]),
      fetch("/api/meal-images")
        .then(r => r.json() as Promise<string[]>)
        .catch(() => [] as string[]),
    ]).then(([folder, local]) => {
      setFolderImages(folder);
      setLocalImages(local);
      setLoading(false);
    });
  }, [mealId]);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const needle = filter.toLowerCase();
  const filteredFolder = needle ? folderImages.filter(f => f.name.toLowerCase().includes(needle) || f.label.toLowerCase().includes(needle)) : folderImages;
  const filteredLocal = needle ? localImages.filter(f => f.toLowerCase().includes(needle)) : localImages;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onMouseDown={onClose}
    >
      <div
        className="relative flex h-[85vh] w-[90vw] max-w-4xl flex-col rounded-lg bg-white shadow-2xl"
        onMouseDown={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-slate-200 px-4 py-3">
          <h2 className="shrink-0 text-sm font-bold text-slate-800">
            Bild wählen · <span className="font-mono text-cyan-700">{mealId}</span>
          </h2>
          <input
            ref={inputRef}
            type="text"
            placeholder="SA, Tray, Name…"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            className="flex-1 rounded border border-slate-300 px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-cyan-500"
          />
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 text-lg leading-none text-slate-400 hover:text-slate-700"
            aria-label="Schließen"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-6">
          {loading ? (
            <div className="flex h-full items-center justify-center text-slate-400">Bilder werden geladen…</div>
          ) : (
            <>
              {filteredFolder.length > 0 && (
                <section>
                  <h3 className="mb-3 text-[11px] font-bold uppercase tracking-[0.12em] text-cyan-800">
                    Aus Bildordner · {filteredFolder.length} {filteredFolder.length !== folderImages.length ? `von ${folderImages.length}` : ""}
                  </h3>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
                    {filteredFolder.map(img => {
                      const isCurrent = img.url === currentUrl;
                      return (
                        <button
                          key={img.url}
                          type="button"
                          onClick={() => { onSelect(img.url); onClose(); }}
                          className={`group flex flex-col overflow-hidden rounded border-2 text-left transition-colors hover:border-cyan-400 ${isCurrent ? "border-cyan-500 ring-2 ring-cyan-200" : "border-slate-200"}`}
                        >
                          <img
                            src={img.url}
                            alt={img.name}
                            className="h-28 w-full object-cover"
                            loading="lazy"
                          />
                          <div className="bg-slate-50 px-1.5 py-1 group-hover:bg-cyan-50">
                            <span className="block truncate font-mono text-[10px] text-slate-600">{img.name.replace(/\.[^.]+$/, "")}</span>
                            <span className={`text-[9px] font-bold ${img.score >= 8 ? "text-cyan-700" : img.score >= 6 ? "text-green-700" : "text-slate-400"}`}>
                              {img.label}{img.score >= 6 ? " ✓" : ""}
                            </span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </section>
              )}

              {folderImages.length === 0 && !loading && (
                <p className="text-sm text-slate-400 italic">
                  Kein Google-Drive-Ordner für {mealId} gefunden — Drive möglicherweise nicht verbunden.
                </p>
              )}

              <section>
                <h3 className="mb-3 text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">
                  Alle lokalen Bilder · {filteredLocal.length}
                </h3>
                {filteredLocal.length === 0 ? (
                  <p className="text-center text-sm text-slate-400">Keine Treffer.</p>
                ) : (
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(130px,1fr))] gap-3">
                    {filteredLocal.map(file => {
                      const url = `/data/meal-images/${file}`;
                      const isCurrent = url === currentUrl;
                      return (
                        <button
                          key={file}
                          type="button"
                          onClick={() => { onSelect(url); onClose(); }}
                          className={`group flex flex-col overflow-hidden rounded border-2 text-left transition-colors hover:border-cyan-400 ${isCurrent ? "border-cyan-500 ring-2 ring-cyan-200" : "border-slate-200"}`}
                        >
                          <img
                            src={url}
                            alt={file}
                            className="h-24 w-full object-cover"
                            loading="lazy"
                          />
                          <span className="truncate bg-slate-50 px-1.5 py-1 font-mono text-[10px] text-slate-600 group-hover:bg-cyan-50">
                            {file.replace(/\.[^.]+$/, "")}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
