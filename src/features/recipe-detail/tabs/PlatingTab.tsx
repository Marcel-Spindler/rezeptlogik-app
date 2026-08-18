import { useCallback, useEffect, useState } from "react";
import type { Market, Recipe } from "../../../core/types";
import { matchesNeedle } from "../../../lib/helpers";

interface Props {
  md: NonNullable<Recipe["markets"][Market]>;
  detailSearch: string;
}

const PLATING_IMAGES_KEY = "rezeptlogik-plating-images-v1";

function usePlatingImages(subRecipeId: string) {
  const [images, setImages] = useState<string[]>(() => {
    try {
      const all = JSON.parse(localStorage.getItem(PLATING_IMAGES_KEY) ?? "{}");
      return all[subRecipeId] ?? [];
    } catch { return []; }
  });

  useEffect(() => {
    try {
      const all = JSON.parse(localStorage.getItem(PLATING_IMAGES_KEY) ?? "{}");
      setImages(all[subRecipeId] ?? []);
    } catch { setImages([]); }
  }, [subRecipeId]);

  const addImage = useCallback((url: string) => {
    setImages(prev => {
      const next = [...prev, url];
      try {
        const all = JSON.parse(localStorage.getItem(PLATING_IMAGES_KEY) ?? "{}");
        all[subRecipeId] = next;
        localStorage.setItem(PLATING_IMAGES_KEY, JSON.stringify(all));
      } catch { /* quota */ }
      return next;
    });
  }, [subRecipeId]);

  const removeImage = useCallback((index: number) => {
    setImages(prev => {
      const next = prev.filter((_, i) => i !== index);
      try {
        const all = JSON.parse(localStorage.getItem(PLATING_IMAGES_KEY) ?? "{}");
        all[subRecipeId] = next;
        localStorage.setItem(PLATING_IMAGES_KEY, JSON.stringify(all));
      } catch { /* quota */ }
      return next;
    });
  }, [subRecipeId]);

  return { images, addImage, removeImage };
}

function PlatingImageSection({ subRecipeId }: { subRecipeId: string }) {
  const { images, addImage, removeImage } = usePlatingImages(subRecipeId);
  const [urlInput, setUrlInput] = useState("");

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") addImage(reader.result);
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  return (
    <div className="mt-3 border-t border-slate-100 pt-3">
      <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-2">Referenzbilder</div>
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {images.map((src, i) => (
            <div key={i} className="relative group">
              <img src={src} alt={`Plating ${i + 1}`} className="h-20 w-20 object-cover rounded-lg ring-1 ring-slate-200" />
              <button
                onClick={() => removeImage(i)}
                className="absolute -top-1 -right-1 hidden group-hover:flex h-5 w-5 items-center justify-center rounded-full bg-rose-500 text-white text-[10px] font-bold"
              >
                x
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <label className="btn text-xs cursor-pointer">
          Bild hochladen
          <input type="file" accept="image/*" className="hidden" onChange={handleFileUpload} />
        </label>
        <input
          type="url"
          value={urlInput}
          onChange={e => setUrlInput(e.target.value)}
          placeholder="Oder URL eingeben..."
          className="flex-1 rounded-lg border-slate-300 ring-1 ring-slate-300 bg-white px-2 py-1 text-xs"
        />
        {urlInput && (
          <button className="btn text-xs" onClick={() => { addImage(urlInput); setUrlInput(""); }}>+</button>
        )}
      </div>
    </div>
  );
}

export function PlatingTab({ md, detailSearch }: Props) {
  const needle = detailSearch.trim().toLowerCase();
  const allBlocks = md.subRecipes
    .filter(s => matchesNeedle([s.name, s.id, s.instructions ?? ""], needle))
    .map(s => ({ name: s.name, id: s.id, text: s.instructions ?? "" }));
  const withText = allBlocks.filter(b => b.text);
  const withoutText = allBlocks.filter(b => !b.text);

  return (
    <div className="space-y-3">
      {allBlocks.length === 0 && (
        <div className="card p-4 text-slate-500">Keine Sub-Rezepte für diese Suche gefunden.</div>
      )}
      {withText.map(b => (
        <div key={b.id} className="card p-4">
          <div className="font-semibold">{b.name}</div>
          <div className="font-mono text-[10px] text-slate-400 mb-2">{b.id}</div>
          <pre className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700">{b.text}</pre>
          <PlatingImageSection subRecipeId={b.id} />
        </div>
      ))}
      {withoutText.length > 0 && (
        <div className="card p-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">
            Sub-Rezepte ohne Plating-Anweisung ({withoutText.length})
          </div>
          <div className="space-y-1">
            {withoutText.map(b => (
              <div key={b.id} className="flex items-center gap-2 text-sm text-slate-500">
                <span className="font-mono text-[10px] text-slate-300 w-32 shrink-0">{b.id}</span>
                <span>{b.name}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
