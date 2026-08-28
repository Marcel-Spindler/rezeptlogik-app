import { useEffect, useRef, useState } from "react";

interface FolderImage {
  name: string;
  score: number;
  label: string;
  size?: number; // Bytes
  url: string; // /api/drive-image?p=...
}

function formatBytes(n?: number): string {
  if (!n) return "";
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(n / 1024)} KB`;
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
  const digits = mealId.match(/\d{4}/)?.[0] ?? "";
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null); // url being saved
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
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !saving) onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, saving]);

  // Drive-Bild auswählen: erst lokal kopieren, dann lokale URL verwenden
  async function handleDriveSelect(img: FolderImage) {
    setSaving(img.url);
    try {
      const driveP = new URLSearchParams(img.url.split("?")[1] ?? "").get("p") ?? "";
      const saveUrl = `/api/save-meal-image?mealId=${encodeURIComponent(mealId)}&p=${encodeURIComponent(driveP)}`;
      const res = await fetch(saveUrl);
      if (res.ok) {
        const { url } = await res.json() as { url: string };
        onSelect(url);
      } else {
        // Fallback: Drive-URL direkt speichern (funktioniert nur im Dev-Server)
        onSelect(img.url);
      }
    } catch {
      onSelect(img.url);
    } finally {
      setSaving(null);
      onClose();
    }
  }

  const needle = filter.toLowerCase();
  // Ordner-Bilder sind bereits meal-spezifisch (API filtert nach Meal-ID) — ohne
  // aktive Suche alle zeigen. (Dateien heißen oft nach dem Gericht, nicht nach dem Code.)
  const filteredFolder = needle
    ? folderImages.filter(f => f.name.toLowerCase().includes(needle) || f.label.toLowerCase().includes(needle))
    : folderImages;
  // Lokale Bilder = kompletter meal-images-Ordner. Ohne Suchbegriff auf dieses Meal eingrenzen.
  const filteredLocal = needle
    ? localImages.filter(f => f.toLowerCase().includes(needle))
    : localImages.filter(f => f.toLowerCase().includes(digits));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onMouseDown={saving ? undefined : onClose}
    >
      <div
        className="relative flex h-[85vh] w-[90vw] max-w-4xl flex-col rounded-lg bg-white shadow-2xl"
        onMouseDown={e => e.stopPropagation()}
      >
        {/* Header */}
        {!import.meta.env.DEV && (
          <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-[11px] text-amber-800">
            Nur lesbar — Bild-Tausch erfordert den lokalen Dev-Server. Dort Bild wählen → Deploy klicken.
          </div>
        )}
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
            onClick={saving ? undefined : onClose}
            disabled={!!saving}
            className="shrink-0 text-lg leading-none text-slate-400 hover:text-slate-700 disabled:opacity-40"
            aria-label="Schließen"
          >
            ✕
          </button>
        </div>

        {/* Saving overlay */}
        {saving && (
          <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-white/80">
            <div className="text-sm font-semibold text-cyan-700">Bild wird gespeichert…</div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-4 space-y-6">
          {loading ? (
            <div className="flex h-full items-center justify-center text-slate-400">Bilder werden geladen…</div>
          ) : (
            <>
              {/* ─── Bilder aus dem Meal-Ordner ─── */}
              {filteredFolder.length > 0 && (
                <section>
                  <h3 className="mb-3 text-[11px] font-bold uppercase tracking-[0.12em] text-cyan-800">
                    Aus Bildordner
                    {filteredFolder.length !== folderImages.length
                      ? ` · ${filteredFolder.length} von ${folderImages.length}`
                      : ` · ${folderImages.length} Bilder`}
                  </h3>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
                    {filteredFolder.map(img => {
                      const isSaving = saving === img.url;
                      return (
                        <button
                          key={img.url}
                          type="button"
                          disabled={!!saving}
                          onClick={() => void handleDriveSelect(img)}
                          className={`group flex flex-col overflow-hidden rounded border-2 text-left transition-colors
                            ${isSaving ? "border-cyan-500 opacity-60" : "border-slate-200 hover:border-cyan-400"}
                            disabled:cursor-wait`}
                        >
                          <img
                            src={img.url}
                            alt={img.name}
                            className="h-28 w-full object-cover"
                            loading="lazy"
                          />
                          <div className="bg-slate-50 px-1.5 py-1 group-hover:bg-cyan-50">
                            <span className="block truncate font-mono text-[10px] text-slate-600">
                              {img.name.replace(/\.[^.]+$/, "")}
                            </span>
                            <span className="flex items-center gap-1.5">
                              <span className={`text-[9px] font-bold ${img.score >= 8 ? "text-cyan-700" : img.score >= 6 ? "text-green-700" : "text-slate-400"}`}>
                                {img.label}{img.score >= 6 ? " ✓" : ""}
                              </span>
                              {img.size ? (
                                <span className={`text-[9px] ${img.size > 5 * 1024 * 1024 ? "font-bold text-red-600" : "text-slate-400"}`}>
                                  {formatBytes(img.size)}{img.size > 5 * 1024 * 1024 ? " ⚠" : ""}
                                </span>
                              ) : null}
                            </span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </section>
              )}

              {/* ─── Alle lokalen Bilder ─── */}
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
                          disabled={!!saving}
                          onClick={() => { onSelect(url); onClose(); }}
                          className={`group flex flex-col overflow-hidden rounded border-2 text-left transition-colors hover:border-cyan-400 disabled:cursor-wait
                            ${isCurrent ? "border-cyan-500 ring-2 ring-cyan-200" : "border-slate-200"}`}
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
