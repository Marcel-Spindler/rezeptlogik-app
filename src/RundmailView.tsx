import { useEffect, useMemo, useRef, useState } from "react";
import type { DataBundle, ProcessSpec, WorkOrderEntry } from "./core/types";

import type {
  BatchHint, DeficitItem, PetRow, PlatingNote, RundmailRow, StatusFilter, WeeklyPlanningData,
} from "./features/rundmail/rundmailTypes";
import {
  detectCsvType, isRun1, loadPlatingNotes, parseDateNeeded, parsePetCsv, parseSeedCsv, savePlatingNotes,
  daySortValue,
} from "./features/rundmail/rundmailParsing";
import { fmtInt, normalizeText, statusTone, toSlack } from "./features/rundmail/rundmailFormat";
import { parseBibleBatchHints, resolveBatchSizeKg, resolveKitchenKgForRow } from "./features/rundmail/rundmailBibleMatch";
import { extractMealCode, buildPetHtmlMail, buildPetPresentationHtml, buildPetSlackBlocks } from "./features/rundmail/rundmailPetMail";
import { buildKetPresentationHtml, buildKetSlackBlocks, buildRun1Mail, buildRunHtmlMail, sendToSlack } from "./features/rundmail/rundmailKetMail";
import { copyHtmlToClipboard, downloadFile, printHtmlAsPdf } from "./features/rundmail/rundmailExport";

export function RundmailView({ data, onNavigate }: { data?: DataBundle; onNavigate?: (view: string) => void } = {}) {
  const [rows, setRows] = useState<RundmailRow[]>([]);
  const [petRows, setPetRows] = useState<PetRow[]>([]);
  const [platingNotes, setPlatingNotes] = useState<Record<string, PlatingNote>>(() => loadPlatingNotes());
  const [platingEditorOpen, setPlatingEditorOpen] = useState(false);
  const platingImageInputRef = useRef<HTMLInputElement | null>(null);
  const [platingImageTargetCode, setPlatingImageTargetCode] = useState<string | null>(null);
  const [selectedDays, setSelectedDays] = useState<Set<string>>(new Set());
  const [searchText, setSearchText] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [isDragging, setIsDragging] = useState(false);
  const [sourceLabel, setSourceLabel] = useState("Seed: public/data/rundmail-seed.csv");
  const [petSourceLabel, setPetSourceLabel] = useState("PET CSV noch nicht geladen");
  const [mailText, setMailText] = useState("");
  const [weeklyPlanning, setWeeklyPlanning] = useState<WeeklyPlanningData | null>(null);
  const [slackWebhookUrl, setSlackWebhookUrl] = useState<string>(
    () => (typeof localStorage !== "undefined" ? localStorage.getItem("slackWebhookUrl") ?? "" : "")
  );
  const [slackWebhookInput, setSlackWebhookInput] = useState<string>(
    () => (typeof localStorage !== "undefined" ? localStorage.getItem("slackWebhookUrl") ?? "" : "")
  );
  const [copyToast, setCopyToast] = useState<string>("");
  const [bibleHints, setBibleHints] = useState<Map<string, BatchHint>>(new Map());
  // Basis-URL für interne Tool-Links im HTML-Export.
  // Im Build: VITE_APP_URL setzen (z.B. https://myapp.example.com). Fallback: aktuelle Origin.
  const appOrigin = ((import.meta.env.VITE_APP_URL as string) || "").replace(/\/$/, "") ||
    (typeof window !== "undefined" ? window.location.origin : "");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const petFileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const response = await fetch("/data/rundmail-seed.csv", { cache: "no-store" });
        if (!response.ok) throw new Error(`Seed CSV konnte nicht geladen werden: ${response.status}`);
        const csvText = await response.text();
        if (cancelled) return;
        const parsedRows = parseSeedCsv(csvText);
        setRows(parsedRows);
      } catch {
        if (!cancelled) {
          setRows([]);
          setSourceLabel("⚠ Seed-CSV konnte nicht geladen werden — bitte CSV manuell hochladen.");
        }
      }
    })();

    (async () => {
      try {
        const res = await fetch("/data/weekly-planning.json", { cache: "no-store" });
        if (!res.ok) return;
        const data: WeeklyPlanningData = await res.json();
        if (!cancelled) setWeeklyPlanning(data);
      } catch {
        // weekly-planning.json optional – kein Fehler
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [masterRes, biblesRes] = await Promise.all([
          fetch("/data/gsheet-dump-NEW_MASTER_SUPERVISORS_WORKLOAD_PLANNING.json"),
          fetch("/data/gsheet-dump-Bibles_K_Operations_Manager_Supervisors.json"),
        ]);
        if (!masterRes.ok || !biblesRes.ok) return;
        const [masterDump, biblesDump] = await Promise.all([masterRes.json(), biblesRes.json()]);
        if (!active) return;
        setBibleHints(parseBibleBatchHints(masterDump, biblesDump));
      } catch {
        // Optional fallback source for capacities.
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const processSpecsByName = useMemo(() => {
    const map = new Map<string, ProcessSpec>();
    for (const spec of Object.values((data?.processSpecs ?? {}) as Record<string, ProcessSpec>)) {
      if (!spec?.name) continue;
      const key = normalizeText(spec.name);
      if (!key || map.has(key)) continue;
      map.set(key, spec);
    }
    return map;
  }, [data]);

  const productionByWorkOrder = useMemo(() => {
    const map = new Map<string, WorkOrderEntry[]>();
    const productionRows = data?.productionPlan?.rows ?? [];
    for (const row of productionRows) {
      const workOrder = (row.workOrder ?? "").trim();
      if (!workOrder) continue;
      const list = map.get(workOrder) ?? [];
      list.push(row);
      map.set(workOrder, list);
    }
    return map;
  }, [data]);

  const enrichedRows = useMemo(() => {
    return rows.map((row) => {
      const kitchenKg = resolveKitchenKgForRow(row, productionByWorkOrder) ?? null;
      const fallbackMinimumKg = row.minimumNeeds > 0 ? row.minimumNeeds : null;
      const demandKg = kitchenKg ?? fallbackMinimumKg;
      const batchSizeKg = resolveBatchSizeKg(row.subRecipeName, processSpecsByName, bibleHints);
      const batchesNeeded = demandKg && batchSizeKg && batchSizeKg > 0
        ? Math.ceil(demandKg / batchSizeKg)
        : null;
      return {
        ...row,
        kitchenKg,
        batchSizeKg,
        batchesNeeded,
      };
    });
  }, [rows, productionByWorkOrder, processSpecsByName, bibleHints]);

  const days = useMemo(() => {
    const run1Days = Array.from(new Set(enrichedRows.filter((row) => isRun1(row.dateNeeded)).map((row) => row.dateNeeded))).sort(
      (a, b) => daySortValue(a) - daySortValue(b)
    );
    if (run1Days.length) return run1Days;
    return Array.from(new Set(enrichedRows.map((row) => row.dateNeeded))).sort((a, b) => daySortValue(a) - daySortValue(b));
  }, [enrichedRows]);

  const run1Rows = useMemo(() => enrichedRows.filter((row) => isRun1(row.dateNeeded)), [enrichedRows]);

  useEffect(() => {
    if (!days.length) {
      setSelectedDays(new Set());
      return;
    }
    // Beim ersten Laden alle Tage vorauswählen; ungültige Tage rauswerfen
    setSelectedDays((prev) => {
      if (prev.size === 0) return new Set(days);
      const valid = days.filter((d) => prev.has(d));
      return valid.length ? new Set(valid) : new Set(days);
    });
  }, [days]);

  const rowsByDay = useMemo(() => {
    const map = new Map<string, RundmailRow[]>();
    enrichedRows.forEach((row) => {
      const list = map.get(row.dateNeeded) ?? [];
      list.push(row);
      map.set(row.dateNeeded, list);
    });
    return map;
  }, [enrichedRows]);

  const visibleRows = useMemo(() => {
    const base = selectedDays.size > 0 ? enrichedRows.filter((row) => selectedDays.has(row.dateNeeded)) : enrichedRows;

    return base.filter((row) => {
      const haystack = [
        row.workOrderNumber,
        row.recipeName,
        row.subRecipeName,
        row.workOrderComment,
        row.stagingComment,
        row.kitchenStatus,
      ]
        .join(" ")
        .toLowerCase();

      const needle = searchText.trim().toLowerCase();
      const searchPass = !needle || haystack.includes(needle);
      const statusPass = statusFilter === "all" || row.kitchenStatus === statusFilter;
      return searchPass && statusPass;
    });
  }, [enrichedRows, searchText, selectedDays, statusFilter]);

  const summary = useMemo(() => {
    // Deduplizierung: Target und Cooked nur einmal pro Rezept zählen,
    // da alle Sub-Rezepte desselben Rezepts identische Portionszahlen haben.
    const seen = new Map<string, RundmailRow>();
    visibleRows.forEach((row) => {
      const prev = seen.get(row.recipeId);
      if (!prev || row.targetPortions > prev.targetPortions) seen.set(row.recipeId, row);
    });
    const deduped = Array.from(seen.values());
    return deduped.reduce(
      (acc, row) => {
        acc.target += row.targetPortions;
        acc.cooked += row.woCookedPortions;
        acc.open += toSlack(row.targetPortions - row.woCookedPortions);
        acc.minNeeds += row.minimumNeeds;
        return acc;
      },
      { target: 0, cooked: 0, open: 0, minNeeds: 0 }
    );
  }, [visibleRows]);

  const run1Summary = useMemo(() => {
    const seen = new Map<string, RundmailRow>();
    run1Rows.forEach((row) => {
      const prev = seen.get(row.recipeId);
      if (!prev || row.targetPortions > prev.targetPortions) seen.set(row.recipeId, row);
    });
    return Array.from(seen.values()).reduce(
      (acc, row) => {
        acc.target += row.targetPortions;
        acc.cooked += row.woCookedPortions;
        return acc;
      },
      { target: 0, cooked: 0 }
    );
  }, [run1Rows]);

  const selectedDayRows = useMemo(() => {
    if (!selectedDays.size) return [];
    return enrichedRows.filter((row) => selectedDays.has(row.dateNeeded));
  }, [enrichedRows, selectedDays]);

  const selectedDayStatus = useMemo(() => {
    return selectedDayRows.reduce<Record<string, number>>((acc, row) => {
      const key = row.kitchenStatus || "Unknown";
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});
  }, [selectedDayRows]);

  const selectedDayTopDeficits = useMemo<DeficitItem[]>(() => {
    return selectedDayRows
      .map((row) => ({ row, deficit: toSlack(row.targetPortions - row.woCookedPortions) }))
      .filter((item) => item.deficit > 0)
      .sort((a, b) => b.deficit - a.deficit)
      .slice(0, 6);
  }, [selectedDayRows]);

  const completionRate = useMemo(() => {
    if (run1Summary.target <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((run1Summary.cooked / run1Summary.target) * 100)));
  }, [run1Summary.cooked, run1Summary.target]);

  const dayCards = useMemo(() => {
    return days.map((day) => {
      const dayRows = rowsByDay.get(day) ?? [];
      const seen = new Map<string, RundmailRow>();
      dayRows.forEach((row) => {
        const prev = seen.get(row.recipeId);
        if (!prev || row.targetPortions > prev.targetPortions) seen.set(row.recipeId, row);
      });
      const deduped = Array.from(seen.values());
      const target = deduped.reduce((sum, row) => sum + row.targetPortions, 0);
      const cooked = deduped.reduce((sum, row) => sum + row.woCookedPortions, 0);
      const open = deduped.reduce((sum, row) => sum + toSlack(row.targetPortions - row.woCookedPortions), 0);
      return { day, count: dayRows.length, target, cooked, open };
    });
  }, [days, rowsByDay]);

  useEffect(() => {
    if (!run1Rows.length) {
      setMailText("");
      return;
    }
    setMailText(buildRun1Mail(run1Rows));
  }, [run1Rows]);

  function applyCsvText(csvText: string, label: string) {
    const parsedRows = parseSeedCsv(csvText);
    setRows(parsedRows);
    setSourceLabel(label);
  }

  function applyPetCsvText(csvText: string, label: string) {
    const parsedRows = parsePetCsv(csvText);
    setPetRows(parsedRows);
    setPetSourceLabel(label);
  }

  function onFileSelected(file: File | null) {
    if (!file) return;
    file
      .text()
      .then((csvText) => {
        const detected = detectCsvType(csvText);
        if (detected === "pet") {
          applyPetCsvText(csvText, `PET Upload (auto erkannt): ${file.name}`);
          return;
        }
        applyCsvText(csvText, `Upload: ${file.name}`);
      })
      .catch(() => {
        setSourceLabel(`Upload fehlgeschlagen: ${file.name}`);
      });
  }

  function onPetFileSelected(file: File | null) {
    if (!file) return;
    file
      .text()
      .then((csvText) => {
        const detected = detectCsvType(csvText);
        if (detected === "ket") {
          applyCsvText(csvText, `KET Upload (auto erkannt): ${file.name}`);
          return;
        }
        applyPetCsvText(csvText, `PET Upload: ${file.name}`);
      })
      .catch(() => {
        setPetSourceLabel(`PET Upload fehlgeschlagen: ${file.name}`);
      });
  }

  function onDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    const file = event.dataTransfer.files?.[0] ?? null;
    if (!file) return;
    file
      .text()
      .then((csvText) => {
        const detected = detectCsvType(csvText);
        if (detected === "pet") {
          applyPetCsvText(csvText, `PET Drag&Drop: ${file.name}`);
          return;
        }
        applyCsvText(csvText, `Drag&Drop: ${file.name}`);
      })
      .catch(() => {
        setSourceLabel(`Upload fehlgeschlagen: ${file.name}`);
      });
  }

  function updateRow(id: string, patch: Partial<Pick<RundmailRow, "kitchenStatus" | "stagingStatus" | "workOrderComment" | "stagingComment">>) {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  function copyCurrentMail() {
    if (!mailText) return;
    void navigator.clipboard.writeText(mailText);
  }

  // @ts-expect-error unused
  const _run1Mail = useMemo(() => buildRun1Mail(run1Rows), [run1Rows]);
  const toolLinks = useMemo(() => ({
    whatIf: appOrigin + "?view=whatif",
    breakdown: appOrigin + "?view=breakdown",
  }), [appOrigin]);
  const run1HtmlMail = useMemo(() => buildRunHtmlMail(enrichedRows, sourceLabel, weeklyPlanning, 1, toolLinks), [enrichedRows, sourceLabel, weeklyPlanning, toolLinks]);
  const run2HtmlMail = useMemo(() => buildRunHtmlMail(enrichedRows, sourceLabel, weeklyPlanning, 2, toolLinks), [enrichedRows, sourceLabel, weeklyPlanning, toolLinks]);
  const petRun1Rows = useMemo(() => petRows.filter((row) => parseDateNeeded(row.productionShift).run === 1), [petRows]);
  const petRun2Rows = useMemo(() => petRows.filter((row) => parseDateNeeded(row.productionShift).run === 2), [petRows]);
  const petRun1HtmlMail = useMemo(() => buildPetHtmlMail(petRows, petSourceLabel, 1, platingNotes), [petRows, petSourceLabel, platingNotes]);
  const petRun2HtmlMail = useMemo(() => buildPetHtmlMail(petRows, petSourceLabel, 2, platingNotes), [petRows, petSourceLabel, platingNotes]);
  const ketPraesi1Html = useMemo(() => buildKetPresentationHtml(enrichedRows, sourceLabel, 1), [enrichedRows, sourceLabel]);
  const ketPraesi2Html = useMemo(() => buildKetPresentationHtml(enrichedRows, sourceLabel, 2), [enrichedRows, sourceLabel]);
  const petPraesi1Html = useMemo(() => buildPetPresentationHtml(petRows, petSourceLabel, 1, platingNotes), [petRows, petSourceLabel, platingNotes]);
  const petPraesi2Html = useMemo(() => buildPetPresentationHtml(petRows, petSourceLabel, 2, platingNotes), [petRows, petSourceLabel, platingNotes]);

  const kitchenStatuses = useMemo(() => {
    const set = new Set<string>();
    enrichedRows.forEach((row) => {
      if (row.kitchenStatus) set.add(row.kitchenStatus);
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [enrichedRows]);

  function showToast(msg: string) {
    setCopyToast(msg);
    setTimeout(() => setCopyToast(""), 4000);
  }

  return (
    <>
    {copyToast && (
      <div className="fixed bottom-6 right-6 z-50 bg-emerald-600 text-white text-sm font-semibold px-5 py-3 rounded-xl shadow-xl flex items-center gap-2 animate-fade-in">
        <span>{copyToast}</span>
      </div>
    )}
    <div className="space-y-4 rundmail-page">
      <section className="card p-4 rundmail-hero">
        <div className="flex flex-wrap items-start justify-between gap-4">
          {/* ── Titel & Status-Chips ── */}
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.16em] text-orange-700">Factor OPS · Verden · Produktionsplanung</div>
            <h2 className="text-2xl font-black text-slate-900 tracking-tight mt-0.5">Tägliche Produktions-Rundmail</h2>
            <p className={`text-xs mt-1 ${sourceLabel.startsWith("⚠") ? "text-red-600 font-semibold" : "text-slate-500"}`}>{sourceLabel}</p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="rundmail-chip">RUN1: {run1Rows.length} WOs</span>
              <span className="rundmail-chip-soft">Completion: {completionRate}%</span>
              {weeklyPlanning ? (
                <span className="rundmail-chip-soft" title={weeklyPlanning.referenceNote}>
                  {weeklyPlanning.isReference ? "⚠ " : "✓ "}KW{weeklyPlanning.cw} geladen
                </span>
              ) : (
                <span className="rundmail-chip-soft text-slate-400">Wochenplan fehlt</span>
              )}
            </div>
          </div>

          {/* ── Button-Gruppen ── */}
          <div className="flex flex-col gap-2 shrink-0">
            {/* Gruppe 1: Daten */}
            <div className="flex flex-wrap gap-1.5">
              <button className="btn" onClick={() => fileInputRef.current?.click()}>
                📂 CSV auswählen
              </button>
              <button className="btn" onClick={() => petFileInputRef.current?.click()}>
                📂 PET CSV auswählen
              </button>
              <button className="btn" onClick={copyCurrentMail} disabled={!mailText}>
                📋 Markdown
              </button>
            </div>
            {/* Gruppe 2: Tools */}
            <div className="flex flex-wrap gap-1.5">
              <button
                className="btn text-blue-700 bg-blue-50 border-blue-200"
                onClick={() => onNavigate?.("whatif")}
              >
                📈 What-If
              </button>
              <button
                className="btn text-emerald-700 bg-emerald-50 border-emerald-200"
                onClick={() => onNavigate?.("breakdown")}
              >
                🔢 Breakdown
              </button>
            </div>
            {/* Gruppe 3: Mail-Export */}
            <div className="flex flex-wrap gap-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 self-center">Email:</span>
              <button type="button" className="btn text-rose-700 bg-rose-50 border-rose-200" onClick={() => printHtmlAsPdf(run1HtmlMail)} disabled={!run1Rows.length} title="Als PDF drucken / speichern">
                📄 KET R1 PDF
              </button>
              <button type="button" className="btn" onClick={() => downloadFile("Run1_Rundmail.html", run1HtmlMail, "text/html;charset=utf-8")} disabled={!run1Rows.length} title="HTML-Datei herunterladen (Fallback)">
                KET R1 ↓
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!run1Rows.length}
                title="HTML in Zwischenablage kopieren → in Gmail/Outlook einfügen"
                onClick={() => copyHtmlToClipboard(run1HtmlMail).then(() => showToast("✓ KET R1 kopiert! Gmail öffnen → Neue Mail → Strg+V einfügen.")).catch((e: Error) => { if (e.message !== "clipboard-fallback") showToast("⚠ Kopieren fehlgeschlagen — Fallback-Tab geöffnet."); })}
              >
                📋 KET R1 kopieren
              </button>
              <button
                type="button"
                className="btn"
                disabled={!run1Rows.length || !slackWebhookUrl}
                title={slackWebhookUrl ? "KET Run 1 Zusammenfassung an Slack senden" : "Slack Webhook URL unten eingeben"}
                onClick={() => sendToSlack(slackWebhookUrl, buildKetSlackBlocks(rows, sourceLabel, 1)).then(() => showToast("✓ KET R1 → Slack gesendet!")).catch(() => showToast("⚠ Slack-Versand fehlgeschlagen — Webhook URL prüfen."))}
              >
                📨 KET R1 → Slack
              </button>
              <button type="button" className="btn text-rose-700 bg-rose-50 border-rose-200" onClick={() => printHtmlAsPdf(run2HtmlMail)} disabled={!rows.length} title="Als PDF drucken / speichern">
                📄 KET R2 PDF
              </button>
              <button type="button" className="btn" onClick={() => downloadFile("Run2_Rundmail.html", run2HtmlMail, "text/html;charset=utf-8")} disabled={!rows.length} title="HTML-Datei herunterladen (Fallback)">
                KET R2 ↓
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!rows.length}
                title="HTML in Zwischenablage kopieren → in Gmail/Outlook einfügen"
                onClick={() => copyHtmlToClipboard(run2HtmlMail).then(() => showToast("✓ KET R2 kopiert! Gmail öffnen → Neue Mail → Strg+V einfügen.")).catch((e: Error) => { if (e.message !== "clipboard-fallback") showToast("⚠ Kopieren fehlgeschlagen — Fallback-Tab geöffnet."); })}
              >
                📋 KET R2 kopieren
              </button>
              <button
                type="button"
                className="btn"
                disabled={!rows.length || !slackWebhookUrl}
                title={slackWebhookUrl ? "KET Run 2 Zusammenfassung an Slack senden" : "Slack Webhook URL unten eingeben"}
                onClick={() => sendToSlack(slackWebhookUrl, buildKetSlackBlocks(rows, sourceLabel, 2)).then(() => showToast("✓ KET R2 → Slack gesendet!")).catch(() => showToast("⚠ Slack-Versand fehlgeschlagen — Webhook URL prüfen."))}
              >
                📨 KET R2 → Slack
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 self-center">PET:</span>
              <button type="button" className="btn text-rose-700 bg-rose-50 border-rose-200" onClick={() => printHtmlAsPdf(petRun1HtmlMail)} disabled={!petRun1Rows.length} title="Als PDF drucken / speichern">
                📄 PET R1 PDF
              </button>
              <button type="button" className="btn" onClick={() => downloadFile("PET_Run1_Plan.html", petRun1HtmlMail, "text/html;charset=utf-8")} disabled={!petRun1Rows.length} title="HTML-Datei herunterladen (Fallback)">
                PET R1 ↓
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!petRun1Rows.length}
                title="PET Plan HTML in Zwischenablage kopieren → in Gmail/Outlook einfügen"
                onClick={() => copyHtmlToClipboard(petRun1HtmlMail).then(() => showToast("✓ PET R1 kopiert! Gmail öffnen → Neue Mail → Strg+V einfügen.")).catch((e: Error) => { if (e.message !== "clipboard-fallback") showToast("⚠ Kopieren fehlgeschlagen — Fallback-Tab geöffnet."); })}
              >
                📋 PET R1 kopieren
              </button>
              <button
                type="button"
                className="btn"
                disabled={!petRun1Rows.length || !slackWebhookUrl}
                title={slackWebhookUrl ? "PET Run 1 Zusammenfassung an Slack senden" : "Slack Webhook URL unten eingeben"}
                onClick={() => sendToSlack(slackWebhookUrl, buildPetSlackBlocks(petRows, petSourceLabel, 1)).then(() => showToast("✓ PET R1 → Slack gesendet!")).catch(() => showToast("⚠ Slack-Versand fehlgeschlagen — Webhook URL prüfen."))}
              >
                📨 PET R1 → Slack
              </button>
              <button type="button" className="btn text-rose-700 bg-rose-50 border-rose-200" onClick={() => printHtmlAsPdf(petRun2HtmlMail)} disabled={!petRun2Rows.length} title="Als PDF drucken / speichern">
                📄 PET R2 PDF
              </button>
              <button type="button" className="btn" onClick={() => downloadFile("PET_Run2_Plan.html", petRun2HtmlMail, "text/html;charset=utf-8")} disabled={!petRun2Rows.length} title="HTML-Datei herunterladen (Fallback)">
                PET R2 ↓
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!petRun2Rows.length}
                title="PET Plan HTML in Zwischenablage kopieren → in Gmail/Outlook einfügen"
                onClick={() => copyHtmlToClipboard(petRun2HtmlMail).then(() => showToast("✓ PET R2 kopiert! Gmail öffnen → Neue Mail → Strg+V einfügen.")).catch((e: Error) => { if (e.message !== "clipboard-fallback") showToast("⚠ Kopieren fehlgeschlagen — Fallback-Tab geöffnet."); })}
              >
                📋 PET R2 kopieren
              </button>
              <button
                type="button"
                className="btn"
                disabled={!petRun2Rows.length || !slackWebhookUrl}
                title={slackWebhookUrl ? "PET Run 2 Zusammenfassung an Slack senden" : "Slack Webhook URL unten eingeben"}
                onClick={() => sendToSlack(slackWebhookUrl, buildPetSlackBlocks(petRows, petSourceLabel, 2)).then(() => showToast("✓ PET R2 → Slack gesendet!")).catch(() => showToast("⚠ Slack-Versand fehlgeschlagen — Webhook URL prüfen."))}
              >
                📨 PET R2 → Slack
              </button>
            </div>
            {/* Gruppe 4: Präsentation PDF */}
            <div className="flex flex-wrap gap-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-violet-500 self-center">Präsi:</span>
              <button
                type="button"
                className="btn text-violet-700 bg-violet-50 border-violet-200 font-bold"
                disabled={!run1Rows.length}
                title="KET Run 1 als saubere Präsentations-PDF öffnen und drucken"
                onClick={() => printHtmlAsPdf(ketPraesi1Html)}
              >
                📊 KET R1 Präsi
              </button>
              <button
                type="button"
                className="btn text-violet-700 bg-violet-50 border-violet-200 font-bold"
                disabled={!rows.length}
                title="KET Run 2 als saubere Präsentations-PDF öffnen und drucken"
                onClick={() => printHtmlAsPdf(ketPraesi2Html)}
              >
                📊 KET R2 Präsi
              </button>
              <button
                type="button"
                className="btn text-indigo-700 bg-indigo-50 border-indigo-200 font-bold"
                disabled={!petRun1Rows.length}
                title="PET Run 1 als saubere Präsentations-PDF öffnen und drucken (inkl. Plating-Anweisungen & Packschema)"
                onClick={() => printHtmlAsPdf(petPraesi1Html)}
              >
                📊 PET R1 Präsi
              </button>
              <button
                type="button"
                className="btn text-indigo-700 bg-indigo-50 border-indigo-200 font-bold"
                disabled={!petRun2Rows.length}
                title="PET Run 2 als saubere Präsentations-PDF öffnen und drucken (inkl. Plating-Anweisungen & Packschema)"
                onClick={() => printHtmlAsPdf(petPraesi2Html)}
              >
                📊 PET R2 Präsi
              </button>
            </div>
            {/* Gruppe 5: Slack Webhook Konfiguration */}
            <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-slate-200">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">🔗 Slack Webhook:</span>
              <input
                type="url"
                title="Slack Incoming Webhook URL"
                placeholder="https://hooks.slack.com/services/..."
                className="flex-1 min-w-[220px] rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 focus:outline-none focus:ring-1 focus:ring-sky-400"
                value={slackWebhookInput}
                onChange={(e) => setSlackWebhookInput(e.target.value)}
              />
              <button
                type="button"
                className="btn text-sky-700 bg-sky-50 border-sky-200"
                onClick={() => {
                  localStorage.setItem("slackWebhookUrl", slackWebhookInput);
                  setSlackWebhookUrl(slackWebhookInput);
                  showToast(slackWebhookInput ? "✓ Slack Webhook gespeichert." : "Slack Webhook entfernt.");
                }}
              >
                Speichern
              </button>
              {slackWebhookUrl && <span className="text-[10px] text-emerald-600 font-semibold">✓ aktiv</span>}
            </div>
          </div>
        </div>
        <input title="KET CSV hochladen" ref={fileInputRef} className="hidden" type="file" accept=".csv,text/csv" onChange={(event) => onFileSelected(event.target.files?.[0] ?? null)} />
        <input title="PET CSV hochladen" ref={petFileInputRef} className="hidden" type="file" accept=".csv,text/csv" onChange={(event) => onPetFileSelected(event.target.files?.[0] ?? null)} />

        <div
          className={`mt-3 rounded-xl border-2 border-dashed p-4 text-sm transition-colors ${
            isDragging ? "border-cyan-500 bg-cyan-50 text-cyan-900" : "border-slate-300 bg-slate-50 text-slate-600"
          }`}
          onDragOver={(event) => {
            event.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={onDrop}
        >
          CSV per Drag-and-Drop hier ablegen. Danach wird die RUN1 Rundmail automatisch erzeugt.
        </div>

        <div className="mt-2 text-xs text-slate-500">
          PET-Quelle: <span className="font-semibold text-slate-700">{petSourceLabel}</span>
        </div>

        {/* ── Plating-Anweisungen & Packschema-Editor ── */}
        <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50">
          <button
            type="button"
            className="w-full flex items-center justify-between px-4 py-2.5 text-xs font-semibold text-emerald-900 hover:bg-emerald-100 rounded-xl transition-colors"
            onClick={() => setPlatingEditorOpen((v) => !v)}
          >
            <span>📋 Plating-Anweisungen &amp; Packschema ({Object.keys(platingNotes).length} gespeichert)</span>
            <span className="text-emerald-600">{platingEditorOpen ? "▲" : "▼"}</span>
          </button>
          {platingEditorOpen && (
            <div className="px-4 pb-4">
              <p className="text-[11px] text-emerald-700 mb-3">
                Anweisungen und Packschema-Bilder werden pro Rezept-Code gespeichert und erscheinen automatisch im PET-PDF-Ausdruck.
                Bilder kannst du einfach per Datei-Upload hinzufügen — sie werden lokal im Browser gespeichert.
              </p>
              {/* Neu-Hinzufügen für Rezept-Codes die nicht im PET sind */}
              {(() => {
                const petCodes = Array.from(new Set(petRows.map((r) => extractMealCode(r.recipeName)))).filter(Boolean).sort();
                const allCodes = Array.from(new Set([...petCodes, ...Object.keys(platingNotes)])).sort();
                return allCodes.map((code) => {
                  const note = platingNotes[code] ?? { instruction: "" };
                  const recipeRow = petRows.find((r) => extractMealCode(r.recipeName) === code);
                  const displayName = recipeRow
                    ? recipeRow.recipeName.replace(/\s*\[.*?\]/g, "").replace(/^FV\d{4}[A-Z]\s*-\s*/i, "").trim()
                    : "";
                  return (
                    <div key={code} className="mb-3 rounded-lg border border-emerald-200 bg-white p-3">
                      <div className="flex items-center justify-between mb-2">
                        <div>
                          <span className="font-mono text-xs font-bold text-emerald-800">{code}</span>
                          {displayName && <span className="ml-2 text-xs text-slate-500">{displayName}</span>}
                        </div>
                        {note.packSchemaImageDataUrl && (
                          <button
                            type="button"
                            className="text-[10px] text-rose-500 hover:text-rose-700"
                            onClick={() => {
                              const updated = { ...platingNotes, [code]: { ...note, packSchemaImageDataUrl: undefined } };
                              setPlatingNotes(updated);
                              savePlatingNotes(updated);
                            }}
                          >
                            Bild entfernen
                          </button>
                        )}
                      </div>
                      <textarea
                        title={`Plating-Anweisung für ${code}`}
                        placeholder="Plating-Anweisung eingeben (z.B. Sauce links, Protein rechts, Garnitur oben)…"
                        rows={2}
                        className="w-full rounded border border-slate-300 px-2 py-1.5 text-xs text-slate-800 resize-none focus:outline-none focus:ring-1 focus:ring-emerald-400"
                        value={note.instruction}
                        onChange={(e) => {
                          const updated = { ...platingNotes, [code]: { ...note, instruction: e.target.value } };
                          setPlatingNotes(updated);
                          savePlatingNotes(updated);
                        }}
                      />
                      <div className="mt-2 flex items-center gap-2">
                        {note.packSchemaImageDataUrl ? (
                          <img
                            src={note.packSchemaImageDataUrl}
                            alt={`Packschema ${code}`}
                            className="h-16 w-auto rounded border border-slate-200 object-contain cursor-pointer"
                            onClick={() => {
                              setPlatingImageTargetCode(code);
                              platingImageInputRef.current?.click();
                            }}
                          />
                        ) : (
                          <button
                            type="button"
                            className="btn text-[11px] py-1"
                            onClick={() => {
                              setPlatingImageTargetCode(code);
                              platingImageInputRef.current?.click();
                            }}
                          >
                            🖼 Packschema-Bild hochladen
                          </button>
                        )}
                        {!petCodes.includes(code) && (
                          <button
                            type="button"
                            className="text-[10px] text-slate-400 hover:text-rose-500 ml-auto"
                            onClick={() => {
                              const { [code]: _removed, ...rest } = platingNotes;
                              setPlatingNotes(rest);
                              savePlatingNotes(rest);
                            }}
                          >
                            Eintrag löschen
                          </button>
                        )}
                      </div>
                    </div>
                  );
                });
              })()}
            </div>
          )}
        </div>
        <input
          ref={platingImageInputRef}
          type="file"
          accept="image/*"
          title="Packschema-Bild hochladen"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (!file || !platingImageTargetCode) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
              const dataUrl = ev.target?.result as string;
              if (!dataUrl) return;
              const img = new Image();
              img.onload = () => {
                const maxDim = 600;
                const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
                const canvas = document.createElement("canvas");
                canvas.width = Math.round(img.width * scale);
                canvas.height = Math.round(img.height * scale);
                const ctx = canvas.getContext("2d");
                if (!ctx) return;
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                const compressed = canvas.toDataURL("image/jpeg", 0.82);
                setPlatingNotes((prev) => {
                  const updated = { ...prev, [platingImageTargetCode]: { ...(prev[platingImageTargetCode] ?? { instruction: "" }), packSchemaImageDataUrl: compressed } };
                  savePlatingNotes(updated);
                  return updated;
                });
              };
              img.src = dataUrl;
            };
            reader.readAsDataURL(file);
            e.target.value = "";
          }}
        />

        <div className="mt-4">
          <div className="flex items-center justify-between text-xs text-slate-600 mb-1">
            <span>RUN1 Fertigstellungsquote (Cooked zu Target)</span>
            <span className="font-semibold text-slate-900">{completionRate}%</span>
          </div>
          <div className="h-2 rounded-full bg-white/70 ring-1 ring-slate-200 overflow-hidden">
            <div className="h-full rundmail-progress" style={{ width: `${completionRate}%` }} />
          </div>
        </div>
      </section>

      <section className="card p-4">
        <div className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500 mb-2">RUN1 Timeline</div>
        <div className="grid gap-2 grid-cols-1 md:grid-cols-2 xl:grid-cols-4">
          {dayCards.map((card) => (
            <button
              key={card.day}
              onClick={() => setSelectedDays((prev) => {
                const next = new Set(prev);
                if (next.has(card.day)) next.delete(card.day); else next.add(card.day);
                return next;
              })}
              className={`text-left rounded-xl p-3 ring-1 transition-all hover:-translate-y-0.5 ${
                selectedDays.has(card.day)
                  ? "bg-slate-900 text-white ring-slate-800 shadow-lg"
                  : "bg-gradient-to-br from-white to-slate-50 ring-slate-200 text-slate-800"
              }`}
            >
              <div className="text-[11px] uppercase tracking-wide opacity-80">{card.day}</div>
              <div className="mt-1 text-xl font-bold">{fmtInt(card.open)}</div>
              <div className="text-[11px] opacity-80">Offen</div>
              <div className="mt-2 text-[11px] opacity-80">{card.count} RUN1 WOs · Target {fmtInt(card.target)}</div>
            </button>
          ))}
        </div>
      </section>

      <section className="card p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1">Tag / Date Needed</div>
            <div className="flex flex-wrap gap-1.5">
              <button
                className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold ring-1 transition-colors ${
                  selectedDays.size === days.length
                    ? "bg-slate-900 text-white ring-slate-800"
                    : "bg-white text-slate-600 ring-slate-300 hover:bg-slate-50"
                }`}
                onClick={() => setSelectedDays(new Set(days))}
              >
                Alle
              </button>
              {days.map((day) => (
                <button
                  key={day}
                  className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold ring-1 transition-colors ${
                    selectedDays.has(day)
                      ? "bg-slate-900 text-white ring-slate-800"
                      : "bg-white text-slate-600 ring-slate-300 hover:bg-slate-50"
                  }`}
                  onClick={() => setSelectedDays((prev) => {
                    const next = new Set(prev);
                    if (next.has(day)) next.delete(day); else next.add(day);
                    return next;
                  })}
                >
                  {day} <span className="opacity-60">({rowsByDay.get(day)?.length ?? 0})</span>
                </button>
              ))}
            </div>
          </div>

          <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Kitchen Status
            <select
              className="mt-1 block min-w-[12rem] rounded-lg border-slate-300 ring-1 ring-slate-300 bg-white px-2 py-2 text-sm"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
            >
              <option value="all">Alle</option>
              {kitchenStatuses.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </label>

          <label className="text-xs font-semibold uppercase tracking-wide text-slate-500 flex-1 min-w-[16rem]">
            Suche
            <input
              className="mt-1 w-full rounded-lg border-slate-300 ring-1 ring-slate-300 bg-white px-3 py-2 text-sm"
              placeholder="WO, Rezept, Sub-Rezept, Kommentar"
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
            />
          </label>
        </div>

        <div className="mt-4 grid grid-cols-2 lg:grid-cols-4 gap-3 text-sm">
          <div className="rounded-xl bg-gradient-to-br from-slate-50 to-white ring-1 ring-slate-200 p-3">
            <div className="text-xs text-slate-500">Target Portions</div>
            <div className="text-2xl font-bold text-slate-900">{fmtInt(summary.target)}</div>
          </div>
          <div className="rounded-xl bg-gradient-to-br from-emerald-50 to-white ring-1 ring-emerald-200 p-3">
            <div className="text-xs text-slate-500">Cooked Portions</div>
            <div className="text-2xl font-bold text-emerald-700">{fmtInt(summary.cooked)}</div>
          </div>
          <div className="rounded-xl bg-gradient-to-br from-amber-50 to-white ring-1 ring-amber-200 p-3">
            <div className="text-xs text-amber-700">Offen (Defizit)</div>
            <div className="text-2xl font-bold text-amber-800">{fmtInt(summary.open)}</div>
          </div>
          <div className="rounded-xl bg-gradient-to-br from-cyan-50 to-white ring-1 ring-cyan-200 p-3">
            <div className="text-xs text-cyan-700">Minimum Needs</div>
            <div className="text-2xl font-bold text-cyan-900">{fmtInt(summary.minNeeds)}</div>
          </div>
        </div>

        <div className="mt-3 rounded-xl bg-gradient-to-br from-indigo-50 to-white ring-1 ring-indigo-200 p-3">
          <div className="text-xs text-indigo-700">Batches gesamt (sichtbare Zeilen)</div>
          <div className="text-2xl font-bold text-indigo-800">
            {fmtInt(visibleRows.reduce((sum, row) => sum + (row.batchesNeeded ?? 0), 0))}
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 xl:grid-cols-2 gap-3">
          <div className="rounded-xl bg-slate-50 ring-1 ring-slate-200 p-3">
            <div className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500 mb-2">Status-Verteilung</div>
            <div className="flex flex-wrap gap-2">
              {Object.entries(selectedDayStatus)
                .sort((a, b) => b[1] - a[1])
                .map(([status, count]) => (
                  <span key={status} className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${statusTone(status)}`}>
                    {status}: {count}
                  </span>
                ))}
            </div>
          </div>

          <div className="rounded-xl bg-rose-50 ring-1 ring-rose-200 p-3">
            <div className="text-xs font-semibold uppercase tracking-[0.12em] text-rose-700 mb-2">Top-Defizite des Tages</div>
            <div className="space-y-1.5">
              {selectedDayTopDeficits.length ? selectedDayTopDeficits.map(({ row, deficit }) => (
                <div key={row.id} className="flex items-start justify-between gap-3 rounded-lg bg-white/80 ring-1 ring-rose-100 px-2 py-1.5 text-xs">
                  <div>
                    <div className="font-semibold text-slate-800">WO {row.workOrderNumber}</div>
                    <div className="text-slate-600 line-clamp-1">{row.subRecipeName}</div>
                  </div>
                  <div className="font-bold text-rose-700">-{fmtInt(deficit)}</div>
                </div>
              )) : <div className="text-xs text-slate-600">Keine offenen Defizite fuer den ausgewaehlten Tag.</div>}
            </div>
          </div>
        </div>
      </section>

      <section className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead className="bg-slate-100 text-slate-700">
              <tr>
                <th className="px-2 py-2 text-left">WO</th>
                <th className="px-2 py-2 text-left">Recipe</th>
                <th className="px-2 py-2 text-left">Sub Recipe</th>
                <th className="px-2 py-2 text-right">Target</th>
                <th className="px-2 py-2 text-right">Cooked</th>
                <th className="px-2 py-2 text-right">Delta</th>
                <th className="px-2 py-2 text-right">Kitchen kg</th>
                <th className="px-2 py-2 text-right">Batch kg</th>
                <th className="px-2 py-2 text-right">Batches</th>
                <th className="px-2 py-2 text-left">Kitchen</th>
                <th className="px-2 py-2 text-left">Staging</th>
                <th className="px-2 py-2 text-left">ETA</th>
                <th className="px-2 py-2 text-left">Kommentar</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => {
                const delta = row.woCookedPortions - row.targetPortions;
                return (
                  <tr key={row.id} className="border-t border-slate-100 align-top">
                    <td className="px-2 py-2 whitespace-nowrap font-medium text-slate-800">{row.workOrderNumber}</td>
                    <td className="px-2 py-2 text-slate-700">{row.recipeName}</td>
                    <td className="px-2 py-2 text-slate-700">{row.subRecipeName}</td>
                    <td className="px-2 py-2 text-right text-slate-700">{fmtInt(row.targetPortions)}</td>
                    <td className="px-2 py-2 text-right text-slate-700">{fmtInt(row.woCookedPortions)}</td>
                    <td className={`px-2 py-2 text-right font-semibold ${delta < 0 ? "text-amber-700" : "text-emerald-700"}`}>
                      {fmtInt(delta)}
                    </td>
                    <td className="px-2 py-2 text-right text-slate-700">{row.kitchenKg != null ? fmtInt(row.kitchenKg) : "-"}</td>
                    <td className="px-2 py-2 text-right text-slate-700">{row.batchSizeKg != null ? fmtInt(row.batchSizeKg) : "-"}</td>
                    <td className="px-2 py-2 text-right font-semibold text-indigo-700">{row.batchesNeeded != null ? fmtInt(row.batchesNeeded) : "-"}</td>
                    <td className="px-2 py-2 min-w-[10rem]">
                      <input
                        title="Kitchen Status"
                        placeholder="Kitchen Status"
                        className="w-full rounded border border-slate-300 px-2 py-1"
                        value={row.kitchenStatus}
                        onChange={(event) => updateRow(row.id, { kitchenStatus: event.target.value })}
                      />
                      <span className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ${statusTone(row.kitchenStatus || "")}`}>
                        {row.kitchenStatus || "Unknown"}
                      </span>
                    </td>
                    <td className="px-2 py-2 min-w-[10rem]">
                      <input
                        title="Staging Status"
                        placeholder="Staging Status"
                        className="w-full rounded border border-slate-300 px-2 py-1"
                        value={row.stagingStatus}
                        onChange={(event) => updateRow(row.id, { stagingStatus: event.target.value })}
                      />
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap text-slate-600">{row.unlockedEta || "-"}</td>
                    <td className="px-2 py-2 min-w-[15rem]">
                      <input
                        title="Work Order Comment"
                        placeholder="Kommentar…"
                        className="w-full rounded border border-slate-300 px-2 py-1"
                        value={row.workOrderComment}
                        onChange={(event) => updateRow(row.id, { workOrderComment: event.target.value })}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card p-4 bg-gradient-to-br from-slate-950 to-slate-900 text-slate-100">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-base font-semibold text-white">Mail Vorschau (Markdown)</h3>
          <span className="text-xs text-slate-300">Markdown + Premium HTML Export bereit fuer Versand</span>
        </div>
        <textarea
          title="Mail Vorschau"
          placeholder="Mail-Inhalt wird hier angezeigt…"
          className="mt-3 w-full min-h-[18rem] rounded-lg border border-slate-700 bg-slate-900 p-3 font-mono text-xs text-slate-100"
          value={mailText}
          onChange={(event) => setMailText(event.target.value)}
        />
      </section>
    </div>
    </>
  );
}
