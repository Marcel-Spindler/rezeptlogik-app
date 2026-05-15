import { useMemo, useState } from "react";
import { usePlanningOasisData, type PlanningOasisDataset } from "./planningOasisData";
import { RACK_V2_LINES, RACK_V2_MARKET_LABEL, type RackV2MarketId } from "./rackV2";

type AgentModel = "gemini-2.5-pro" | "gemini-2.5-flash" | "gemini-1.5-pro" | "gpt-4.1" | "gpt-4o-mini";
type AgentProvider = "gemini" | "github-models";
type AgentVerdict = "fertig" | "mist" | "besser";
type AgentExecutionMode = "single" | "dual-compare";
type UploadAttachment = {
  name: string;
  mimeType: string;
  sizeBytes: number;
  contentBase64: string;
};

type AccessMode = "role-based" | "token" | "none";
type FallbackMode = "deterministic" | "safe-stop" | "manual-handoff";

type AgentCapabilities = {
  optimizeWeekPlan: boolean;
  detectBottlenecks: boolean;
  proposeRackMoves: boolean;
  runWhatIf: boolean;
  explainDecisions: boolean;
  writeBackSuggestions: boolean;
};

type DataSources = {
  planningTruth: boolean;
  kplDump: boolean;
  pdlForecast: boolean;
  linePlating: boolean;
  rackWorkbook: boolean;
  wmsLive: boolean;
};

type RackRules = {
  enforceFixedPackagingSlots: boolean;
  enforceDeLinerRules: boolean;
  enforceForezoneSlots: boolean;
  enforceTierLogic: boolean;
  enforceRecommendedActiveBlocks: boolean;
  marketByLine: Record<string, RackV2MarketId>;
  selectedLines: string[];
};

type AccessRules = {
  mode: AccessMode;
  canTrigger: string[];
  canApprove: string[];
  canPublish: string[];
  requireApproval: boolean;
};

type TelemetryRules = {
  enabled: boolean;
  trackToolCalls: boolean;
  trackLatency: boolean;
  trackConfidence: boolean;
  hashUserInput: boolean;
  retentionDays: number;
};

type FallbackRules = {
  mode: FallbackMode;
  timeoutMs: number;
  maxRetries: number;
  useDeterministicPlannerOnFailure: boolean;
  notifyOpsOnFailure: boolean;
};

type AgentActionRules = {
  defaultDryRun: boolean;
  allowPlanWrite: boolean;
  allowRackWrite: boolean;
  allowMailDraft: boolean;
};

type AgentSetupSchema = {
  name: string;
  ownerTeam: string;
  provider: AgentProvider;
  model: AgentModel;
  executionMode: AgentExecutionMode;
  secondaryProvider: AgentProvider;
  secondaryModel: AgentModel;
  automationProfile: "two-run-mhd-backward-submeal";
  language: "de";
  weekContext: string;
  capabilities: AgentCapabilities;
  dataSources: DataSources;
  rackV2Rules: RackRules;
  access: AccessRules;
  telemetry: TelemetryRules;
  fallback: FallbackRules;
  actions: AgentActionRules;
};

const DEFAULT_ROLES_TRIGGER = ["planner", "line-lead", "ops-manager"];
const DEFAULT_ROLES_APPROVE = ["ops-manager", "production-manager"];
const DEFAULT_ROLES_PUBLISH = ["production-manager"];

function defaultSchema(week: string): AgentSetupSchema {
  const marketByLine: Record<string, RackV2MarketId> = {};
  for (const line of RACK_V2_LINES) {
    marketByLine[line.code] = line.defaultMarket;
  }

  return {
    name: "Planning-OASE-Agent",
    ownerTeam: "Operations Planning",
    provider: "gemini",
    model: "gemini-2.5-pro",
    executionMode: "dual-compare",
    secondaryProvider: "github-models",
    secondaryModel: "gpt-4.1",
    automationProfile: "two-run-mhd-backward-submeal",
    language: "de",
    weekContext: week,
    capabilities: {
      optimizeWeekPlan: true,
      detectBottlenecks: true,
      proposeRackMoves: true,
      runWhatIf: true,
      explainDecisions: true,
      writeBackSuggestions: true,
    },
    dataSources: {
      planningTruth: true,
      kplDump: true,
      pdlForecast: true,
      linePlating: true,
      rackWorkbook: true,
      wmsLive: false,
    },
    rackV2Rules: {
      enforceFixedPackagingSlots: true,
      enforceDeLinerRules: true,
      enforceForezoneSlots: true,
      enforceTierLogic: true,
      enforceRecommendedActiveBlocks: true,
      selectedLines: RACK_V2_LINES.map(line => line.code),
      marketByLine,
    },
    access: {
      mode: "role-based",
      canTrigger: DEFAULT_ROLES_TRIGGER,
      canApprove: DEFAULT_ROLES_APPROVE,
      canPublish: DEFAULT_ROLES_PUBLISH,
      requireApproval: true,
    },
    telemetry: {
      enabled: true,
      trackToolCalls: true,
      trackLatency: true,
      trackConfidence: true,
      hashUserInput: true,
      retentionDays: 30,
    },
    fallback: {
      mode: "deterministic",
      timeoutMs: 12000,
      maxRetries: 1,
      useDeterministicPlannerOnFailure: true,
      notifyOpsOnFailure: true,
    },
    actions: {
      defaultDryRun: true,
      allowPlanWrite: false,
      allowRackWrite: false,
      allowMailDraft: true,
    },
  };
}

function parseCsvRoles(raw: string): string[] {
  return raw
    .split(",")
    .map(part => part.trim())
    .filter(Boolean);
}

function formatCsvRoles(values: string[]): string {
  return values.join(", ");
}

function uniqueWeekRecipes(dataset: PlanningOasisDataset | null, week: string): Array<{
  code: string;
  name: string;
  role: string;
  workOrders: number;
  targetPortions: number;
  forecastTotal: number;
  gap: number;
  methods: string[];
}> {
  if (!dataset) return [];
  const seen = new Set<string>();
  return Object.values(dataset.recipes)
    .filter((recipe) => recipe.weeks.includes(week))
    .filter((recipe) => {
      if (seen.has(recipe.recipeDigitKey)) return false;
      seen.add(recipe.recipeDigitKey);
      return true;
    })
    .sort((a, b) => b.totalTargetPortions - a.totalTargetPortions || a.recipeCode.localeCompare(b.recipeCode, "de"))
    .map((recipe) => ({
      code: recipe.recipeCode,
      name: recipe.recipeName,
      role: recipe.planningRole,
      workOrders: recipe.workOrders.length,
      targetPortions: recipe.totalTargetPortions,
      forecastTotal: recipe.forecastTotal,
      gap: recipe.gaps.targetVsForecast,
      methods: recipe.methods.slice(0, 4),
    }))
    .slice(0, 12);
}

function buildPlanningOasisTrainingPack(dataset: PlanningOasisDataset | null, week: string) {
  const weekIntel = dataset?.weeks[week] ?? null;
  const recipes = uniqueWeekRecipes(dataset, week);
  return {
    week,
    source: {
      hasDataset: Boolean(dataset),
      hasWeekIntel: Boolean(weekIntel),
      recipeCount: weekIntel?.recipes.length ?? 0,
      workOrderCount: weekIntel?.workOrderCount ?? 0,
      totalTargetPortions: weekIntel?.totalTargetPortions ?? 0,
      platingTotal: weekIntel?.platingTotal ?? 0,
      forecastTotal: weekIntel?.forecastTotal ?? 0,
      pdlPortions: weekIntel?.pdlPortions ?? 0,
    },
    weekIntel: weekIntel ? {
      forecastByMarket: weekIntel.forecastByMarket,
      factoryRecipeCount: weekIntel.factoryRecipeCount,
      hybridRecipeCount: weekIntel.hybridRecipeCount,
      suppliedRecipeCount: weekIntel.suppliedRecipeCount,
      factoryPdlPortions: weekIntel.factoryPdlPortions,
      hybridPdlPortions: weekIntel.hybridPdlPortions,
      suppliedPdlPortions: weekIntel.suppliedPdlPortions,
      methods: weekIntel.methods,
      dueDays: weekIntel.dueDays,
    } : null,
    recipes,
    rules: {
      planLogic: "2-run MHD: Run1 bis Mittwoch, Run2 bis Freitag; Sub-Meals rueckwaerts vom Bedarfstag; lange Sub-Meals frueher.",
      rackLogic: "Rack-V2 strikt nach Linien, Blocks, Packaging, Tier und Recommended Active Blocks.",
      answerStyle: "Wenn etwas gut ist: fertig. Wenn es falsch oder riskant ist: mist. Wenn es verbessert werden kann: besser.",
      responseExpectation: "Antworte als Planer mit konkreter Entscheidung, kurzer Begruendung und naechstem Schritt.",
    },
  };
}

export function PlanningOasisAgentForm({ week }: { week: string }): JSX.Element {
  const [schema, setSchema] = useState<AgentSetupSchema>(() => defaultSchema(week));
  const [status, setStatus] = useState<string>("");
  const [lastResult, setLastResult] = useState<Record<string, unknown> | null>(null);
  const [objective, setObjective] = useState<string>("Plane diese Woche strikt im 2-Run-MHD-Modell: Run1 bis Mittwoch, Run2 bis Freitag, und priorisiere Sub-Meals rueckwaerts vom Bedarfstag.");
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [attachments, setAttachments] = useState<UploadAttachment[]>([]);
  const [proposalId, setProposalId] = useState<string>("");
  const [actorRole, setActorRole] = useState<string>("ops-manager");
  const [actorId, setActorId] = useState<string>("local-user");
  const [accessToken, setAccessToken] = useState<string>("");
  const [approveComment, setApproveComment] = useState<string>("Freigabe nach Dry-Run-Pruefung");
  const { data: oasisData, loading: oasisLoading } = usePlanningOasisData();

  const trainingPack = useMemo(() => buildPlanningOasisTrainingPack(oasisData, week), [oasisData, week]);
  const schemaJson = useMemo(() => JSON.stringify({ ...schema, planningOasisContext: trainingPack }, null, 2), [schema, trainingPack]);
  const comparison = asRecord(lastResult?.comparison);

  function resetPreset(): void {
    setSchema(defaultSchema(week));
    setStatus("Best-Practice-Preset geladen.");
    setLastResult(null);
  }

  async function copySchema(): Promise<void> {
    try {
      await navigator.clipboard.writeText(schemaJson);
      setStatus("Schema in Zwischenablage kopiert.");
    } catch {
      setStatus("Kopieren fehlgeschlagen. Bitte manuell aus dem JSON-Feld kopieren.");
    }
  }

  function downloadSchema(): void {
    const blob = new Blob([schemaJson], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `planning-oase-agent-${schema.weekContext}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setStatus("Schema als JSON exportiert.");
  }

  function updateSecondaryProvider(provider: AgentProvider): void {
    setSchema((prev) => ({
      ...prev,
      secondaryProvider: provider,
      secondaryModel: provider === "github-models"
        ? (prev.secondaryModel === "gpt-4.1" || prev.secondaryModel === "gpt-4o-mini" ? prev.secondaryModel : "gpt-4.1")
        : (prev.secondaryModel === "gemini-2.5-pro" || prev.secondaryModel === "gemini-2.5-flash" || prev.secondaryModel === "gemini-1.5-pro" ? prev.secondaryModel : "gemini-2.5-pro"),
    }));
  }

  function verdictTone(verdict: unknown): string {
    if (verdict === "fertig") return "bg-emerald-50 text-emerald-800 ring-emerald-200";
    if (verdict === "mist") return "bg-rose-50 text-rose-800 ring-rose-200";
    return "bg-amber-50 text-amber-800 ring-amber-200";
  }

  function verdictLabel(verdict: unknown): string {
    if (verdict === "fertig") return "fertig";
    if (verdict === "mist") return "mist";
    if (verdict === "besser") return "besser";
    return "unbekannt";
  }

  function parseApiResponse(text: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    } catch {
      return { raw: text };
    }
  }

  function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" ? value as Record<string, unknown> : null;
  }

  async function triggerAgent(): Promise<void> {
    setIsRunning(true);
    setStatus("Agent startet ...");
    try {
      const response = await fetch("/api/agent-run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ schema, objective, attachments, actorRole, actorId, accessToken, planningOasisContext: trainingPack }),
      });
      const raw = await response.text();
      const data = parseApiResponse(raw);
      if (!response.ok || !data?.ok) {
        const extra = String(data?.raw || "").slice(0, 220);
        throw new Error(String(data?.error || `HTTP ${response.status}${extra ? `: ${extra}` : ""}`));
      }

      const resultObject = (data.result && typeof data.result === "object")
        ? data.result as Record<string, unknown>
        : {};

      setLastResult(resultObject);
      const summary = {
        runId: data.runId,
        provider: data.provider,
        model: data.model,
        usedFallback: Boolean(data.usedFallback),
        attachments: attachments.length,
        proposalId: data.proposalId || data.runId,
        summary: String(resultObject.summary || "(keine summary)"),
        verdict: verdictLabel(resultObject.verdict),
      };
      setProposalId(String(data.proposalId || data.runId || ""));
      setStatus(`Dry-Run erfolgreich: ${JSON.stringify(summary)}`);
    } catch (error) {
      setStatus(`Agent-Run fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsRunning(false);
    }
  }

  async function approveProposal(): Promise<void> {
    if (!proposalId.trim()) {
      setStatus("Bitte zuerst Dry-Run ausfuehren oder Proposal-ID eintragen.");
      return;
    }
    setIsRunning(true);
    setStatus("Freigabe wird gespeichert ...");
    try {
      const response = await fetch("/api/agent-approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          proposalId,
          actorRole,
          actorId,
          accessToken,
          comment: approveComment,
        }),
      });
      const raw = await response.text();
      const data = parseApiResponse(raw);
      if (!response.ok || !data?.ok) {
        const extra = String(data?.raw || "").slice(0, 220);
        throw new Error(String(data?.error || `HTTP ${response.status}${extra ? `: ${extra}` : ""}`));
      }
      setStatus(`Freigabe gespeichert: ${JSON.stringify({ proposalId: data.proposalId, status: data.status, approvedAt: data.approvedAt })}`);
    } catch (error) {
      setStatus(`Freigabe fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsRunning(false);
    }
  }

  async function applyProposal(): Promise<void> {
    if (!proposalId.trim()) {
      setStatus("Bitte zuerst Dry-Run ausfuehren oder Proposal-ID eintragen.");
      return;
    }
    setIsRunning(true);
    setStatus("Apply wird ausgefuehrt ...");
    try {
      const response = await fetch("/api/agent-apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          proposalId,
          actorRole,
          actorId,
          accessToken,
        }),
      });
      const raw = await response.text();
      const data = parseApiResponse(raw);
      if (!response.ok || !data?.ok) {
        const extra = String(data?.raw || "").slice(0, 220);
        throw new Error(String(data?.error || `HTTP ${response.status}${extra ? `: ${extra}` : ""}`));
      }
      setStatus(`Apply erfolgreich: ${JSON.stringify({ proposalId: data.proposalId, applyId: data.applyId, writes: data.writes })}`);
    } catch (error) {
      setStatus(`Apply fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsRunning(false);
    }
  }

  function bytesToBase64(bytes: Uint8Array): string {
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
  }

  async function handleFileChange(files: FileList | null): Promise<void> {
    if (!files || files.length === 0) {
      setAttachments([]);
      return;
    }

    const next: UploadAttachment[] = [];
    const maxFiles = 6;
    const maxBytes = 2 * 1024 * 1024;

    for (const file of Array.from(files).slice(0, maxFiles)) {
      if (file.size > maxBytes) continue;
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      next.push({
        name: file.name,
        mimeType: file.type || "application/octet-stream",
        sizeBytes: file.size,
        contentBase64: bytesToBase64(bytes),
      });
    }

    setAttachments(next);
    setStatus(`Uploads gesetzt: ${next.length} Datei(en).`);
  }

  function toggleCapability(key: keyof AgentCapabilities): void {
    setSchema(prev => ({
      ...prev,
      capabilities: {
        ...prev.capabilities,
        [key]: !prev.capabilities[key],
      },
    }));
  }

  function toggleSource(key: keyof DataSources): void {
    setSchema(prev => ({
      ...prev,
      dataSources: {
        ...prev.dataSources,
        [key]: !prev.dataSources[key],
      },
    }));
  }

  function toggleRackRule(key: keyof Omit<RackRules, "marketByLine" | "selectedLines">): void {
    setSchema(prev => ({
      ...prev,
      rackV2Rules: {
        ...prev.rackV2Rules,
        [key]: !prev.rackV2Rules[key],
      },
    }));
  }

  function setRoles(
    key: "canTrigger" | "canApprove" | "canPublish",
    value: string,
  ): void {
    setSchema(prev => ({
      ...prev,
      access: {
        ...prev.access,
        [key]: parseCsvRoles(value),
      },
    }));
  }

  function toggleLine(lineCode: string): void {
    setSchema(prev => {
      const selected = prev.rackV2Rules.selectedLines;
      const nextSelected = selected.includes(lineCode)
        ? selected.filter(code => code !== lineCode)
        : [...selected, lineCode];
      return {
        ...prev,
        rackV2Rules: {
          ...prev.rackV2Rules,
          selectedLines: nextSelected,
        },
      };
    });
  }

  return (
    <div className="space-y-4">
      {status && (
        <div className={`card p-3 text-sm font-semibold ring-1 ${status.toLowerCase().includes("fehlgeschlagen") ? "bg-rose-50 text-rose-800 ring-rose-200" : "bg-emerald-50 text-emerald-800 ring-emerald-200"}`}>
          {status}
        </div>
      )}

      <div className="card p-5 border-2 border-sky-200 bg-gradient-to-r from-sky-50 via-white to-emerald-50">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-xl font-black tracking-tight text-slate-900">Agent Setup Formular (Gemini)</h3>
            <p className="mt-1 text-sm text-slate-600">
              Komplett durchklicken, Schema exportieren und per Button Agent-Run vorbereiten.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={resetPreset} className="rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50">
              Preset laden
            </button>
            <button onClick={copySchema} className="rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50">
              JSON kopieren
            </button>
            <button onClick={downloadSchema} className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800">
              JSON exportieren
            </button>
          </div>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <section className="card p-4 space-y-3">
          <h4 className="text-sm font-bold text-slate-800">1) Agent Basis</h4>
          <label className="block text-xs font-semibold text-slate-600">Agent Name</label>
          <input
            value={schema.name}
            onChange={(event) => setSchema(prev => ({ ...prev, name: event.target.value }))}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
          <label className="block text-xs font-semibold text-slate-600">Owner Team</label>
          <input
            value={schema.ownerTeam}
            onChange={(event) => setSchema(prev => ({ ...prev, ownerTeam: event.target.value }))}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-600">Provider</label>
              <select
                value={schema.provider}
                onChange={(event) => {
                  const nextProvider = event.target.value as AgentProvider;
                  setSchema(prev => ({
                    ...prev,
                    provider: nextProvider,
                    model: nextProvider === "github-models"
                      ? (prev.model === "gpt-4.1" || prev.model === "gpt-4o-mini" ? prev.model : "gpt-4.1")
                      : (prev.model === "gemini-2.5-pro" || prev.model === "gemini-2.5-flash" || prev.model === "gemini-1.5-pro" ? prev.model : "gemini-2.5-pro"),
                  }));
                }}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              >
                <option value="gemini">Gemini API</option>
                <option value="github-models">GitHub Models (Copilot-nah)</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600">Modell</label>
              <select
                value={schema.model}
                onChange={(event) => setSchema(prev => ({ ...prev, model: event.target.value as AgentModel }))}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              >
                {schema.provider === "gemini" ? (
                  <>
                    <option value="gemini-2.5-pro">Gemini 2.5 Pro</option>
                    <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
                    <option value="gemini-1.5-pro">Gemini 1.5 Pro</option>
                  </>
                ) : (
                  <>
                    <option value="gpt-4.1">gpt-4.1</option>
                    <option value="gpt-4o-mini">gpt-4o-mini</option>
                  </>
                )}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600">Execution Mode</label>
              <select
                value={schema.executionMode}
                onChange={(event) => setSchema(prev => ({ ...prev, executionMode: event.target.value as AgentExecutionMode }))}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              >
                <option value="single">Single Agent</option>
                <option value="dual-compare">Dual Compare</option>
              </select>
            </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-slate-600">Zweit-Provider</label>
                <select
                  value={schema.secondaryProvider}
                  onChange={(event) => updateSecondaryProvider(event.target.value as AgentProvider)}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                >
                  <option value="gemini">Gemini API</option>
                  <option value="github-models">GitHub Models</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600">Zweit-Modell</label>
                <select
                  value={schema.secondaryModel}
                  onChange={(event) => setSchema(prev => ({ ...prev, secondaryModel: event.target.value as AgentModel }))}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                >
                  {schema.secondaryProvider === "gemini" ? (
                    <>
                      <option value="gemini-2.5-pro">Gemini 2.5 Pro</option>
                      <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
                      <option value="gemini-1.5-pro">Gemini 1.5 Pro</option>
                    </>
                  ) : (
                    <>
                      <option value="gpt-4.1">gpt-4.1</option>
                      <option value="gpt-4o-mini">gpt-4o-mini</option>
                    </>
                  )}
                </select>
              </div>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600">KW Kontext</label>
              <input
                value={schema.weekContext}
                onChange={(event) => setSchema(prev => ({ ...prev, weekContext: event.target.value }))}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
          </div>
            <div className="rounded-lg bg-amber-50 p-2 text-xs text-amber-900 ring-1 ring-amber-200">
              {oasisLoading ? "Planning OASE Kontext wird geladen ..." : `Planning OASE TrainingPack aktiv: ${trainingPack.source.recipeCount} Rezepte, ${trainingPack.source.workOrderCount} Auftraege, ${trainingPack.source.totalTargetPortions} Zielportionen.`}
            </div>
            <div className="rounded-lg bg-slate-50 p-2 text-xs text-slate-600 ring-1 ring-slate-200">
              {schema.provider === "github-models"
                ? "GitHub Models aktiviert. Im Backend werden GITHUB_MODELS_API_KEY und optional GITHUB_MODELS_ENDPOINT genutzt."
                : "Gemini aktiviert. Im Backend wird GEMINI_API_KEY genutzt."}
            </div>
        </section>

        <section className="card p-4 space-y-3">
          <h4 className="text-sm font-bold text-slate-800">2) Fähigkeiten</h4>
          {([
            ["optimizeWeekPlan", "Wochenplanung optimieren"],
            ["detectBottlenecks", "Engpaesse erkennen"],
            ["proposeRackMoves", "Rack-V2 Moves vorschlagen"],
            ["runWhatIf", "What-if rechnen"],
            ["explainDecisions", "Entscheidungen erklaeren"],
            ["writeBackSuggestions", "Vorschlaege speichern"],
          ] as Array<[keyof AgentCapabilities, string]>).map(([key, label]) => (
            <label key={key} className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={schema.capabilities[key]} onChange={() => toggleCapability(key)} />
              <span>{label}</span>
            </label>
          ))}
        </section>

        <section className="card p-4 space-y-3">
          <h4 className="text-sm font-bold text-slate-800">3) Datenquellen</h4>
          {([
            ["planningTruth", "Planning Truth"],
            ["kplDump", "KPL Dump"],
            ["pdlForecast", "PDL Forecast"],
            ["linePlating", "LinePlating"],
            ["rackWorkbook", "Rack Workbook"],
            ["wmsLive", "WMS Live"],
          ] as Array<[keyof DataSources, string]>).map(([key, label]) => (
            <label key={key} className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={schema.dataSources[key]} onChange={() => toggleSource(key)} />
              <span>{label}</span>
            </label>
          ))}
        </section>

        <section className="card p-4 space-y-3">
          <h4 className="text-sm font-bold text-slate-800">4) Rack V2 Regeln</h4>
          {([
            ["enforceFixedPackagingSlots", "Packaging-Slots fix erzwingen"],
            ["enforceDeLinerRules", "DE Liner-Regeln erzwingen"],
            ["enforceForezoneSlots", "Forezone-Slotregeln erzwingen"],
            ["enforceTierLogic", "Tier-Logik pruefen"],
            ["enforceRecommendedActiveBlocks", "Empfohlene aktive Bloecke nutzen"],
          ] as Array<[keyof Omit<RackRules, "marketByLine" | "selectedLines">, string]>).map(([key, label]) => (
            <label key={key} className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={schema.rackV2Rules[key]} onChange={() => toggleRackRule(key)} />
              <span>{label}</span>
            </label>
          ))}
          <div className="mt-2 rounded-lg bg-slate-50 p-3 ring-1 ring-slate-200">
            <div className="text-xs font-semibold text-slate-600">Linien und Marktzuordnung</div>
            <div className="mt-2 space-y-2">
              {RACK_V2_LINES.map(line => (
                <div key={line.code} className="grid grid-cols-[auto_1fr_auto] items-center gap-2">
                  <input
                    type="checkbox"
                    checked={schema.rackV2Rules.selectedLines.includes(line.code)}
                    onChange={() => toggleLine(line.code)}
                  />
                  <span className="text-sm font-semibold text-slate-700">{line.code}</span>
                  <select
                    value={schema.rackV2Rules.marketByLine[line.code]}
                    onChange={(event) => {
                      const market = event.target.value as RackV2MarketId;
                      setSchema(prev => ({
                        ...prev,
                        rackV2Rules: {
                          ...prev.rackV2Rules,
                          marketByLine: {
                            ...prev.rackV2Rules.marketByLine,
                            [line.code]: market,
                          },
                        },
                      }));
                    }}
                    className="rounded-lg border border-slate-300 px-2 py-1 text-xs"
                  >
                    <option value="DE">{RACK_V2_MARKET_LABEL.DE}</option>
                    <option value="DKSE">{RACK_V2_MARKET_LABEL.DKSE}</option>
                    <option value="BENL">{RACK_V2_MARKET_LABEL.BENL}</option>
                  </select>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="card p-4 space-y-3">
          <h4 className="text-sm font-bold text-slate-800">5) Zugriff</h4>
          <div>
            <label className="block text-xs font-semibold text-slate-600">Zugriffsmodus</label>
            <select
              value={schema.access.mode}
              onChange={(event) => setSchema(prev => ({ ...prev, access: { ...prev.access, mode: event.target.value as AccessMode } }))}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            >
              <option value="role-based">Role Based</option>
              <option value="token">Token</option>
              <option value="none">Offen (nur lokal testen)</option>
            </select>
          </div>
          <label className="block text-xs font-semibold text-slate-600">Rollen duerfen triggern (CSV)</label>
          <input
            value={formatCsvRoles(schema.access.canTrigger)}
            onChange={(event) => setRoles("canTrigger", event.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
          <label className="block text-xs font-semibold text-slate-600">Rollen duerfen freigeben (CSV)</label>
          <input
            value={formatCsvRoles(schema.access.canApprove)}
            onChange={(event) => setRoles("canApprove", event.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
          <label className="block text-xs font-semibold text-slate-600">Rollen duerfen publishen (CSV)</label>
          <input
            value={formatCsvRoles(schema.access.canPublish)}
            onChange={(event) => setRoles("canPublish", event.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={schema.access.requireApproval}
              onChange={() => setSchema(prev => ({ ...prev, access: { ...prev.access, requireApproval: !prev.access.requireApproval } }))}
            />
            <span>Freigabe vor Write-Aktionen erzwingen</span>
          </label>
        </section>

        <section className="card p-4 space-y-3">
          <h4 className="text-sm font-bold text-slate-800">6) Telemetrie</h4>
          {([
            ["enabled", "Telemetrie aktiv"],
            ["trackToolCalls", "Tool Calls loggen"],
            ["trackLatency", "Latenz messen"],
            ["trackConfidence", "Konfidenz speichern"],
            ["hashUserInput", "User Input nur gehasht speichern"],
          ] as Array<[keyof Omit<TelemetryRules, "retentionDays">, string]>).map(([key, label]) => (
            <label key={key} className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={schema.telemetry[key]}
                onChange={() => setSchema(prev => ({ ...prev, telemetry: { ...prev.telemetry, [key]: !prev.telemetry[key] } }))}
              />
              <span>{label}</span>
            </label>
          ))}
          <label className="block text-xs font-semibold text-slate-600">Retention (Tage)</label>
          <input
            type="number"
            min={1}
            max={365}
            value={schema.telemetry.retentionDays}
            onChange={(event) => setSchema(prev => ({
              ...prev,
              telemetry: { ...prev.telemetry, retentionDays: Math.max(1, Math.min(365, Number(event.target.value) || 1)) },
            }))}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </section>

        <section className="card p-4 space-y-3">
          <h4 className="text-sm font-bold text-slate-800">7) Fallback</h4>
          <div>
            <label className="block text-xs font-semibold text-slate-600">Fallback Modus</label>
            <select
              value={schema.fallback.mode}
              onChange={(event) => setSchema(prev => ({ ...prev, fallback: { ...prev.fallback, mode: event.target.value as FallbackMode } }))}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            >
              <option value="deterministic">Deterministisch (Rule Engine)</option>
              <option value="safe-stop">Safe Stop</option>
              <option value="manual-handoff">Manueller Handoff</option>
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-600">Timeout (ms)</label>
              <input
                type="number"
                min={1000}
                step={500}
                value={schema.fallback.timeoutMs}
                onChange={(event) => setSchema(prev => ({ ...prev, fallback: { ...prev.fallback, timeoutMs: Math.max(1000, Number(event.target.value) || 1000) } }))}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600">Retries</label>
              <input
                type="number"
                min={0}
                max={5}
                value={schema.fallback.maxRetries}
                onChange={(event) => setSchema(prev => ({ ...prev, fallback: { ...prev.fallback, maxRetries: Math.max(0, Math.min(5, Number(event.target.value) || 0)) } }))}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={schema.fallback.useDeterministicPlannerOnFailure}
              onChange={() => setSchema(prev => ({
                ...prev,
                fallback: {
                  ...prev.fallback,
                  useDeterministicPlannerOnFailure: !prev.fallback.useDeterministicPlannerOnFailure,
                },
              }))}
            />
            <span>Bei Modellfehler auf deterministische Planung wechseln</span>
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={schema.fallback.notifyOpsOnFailure}
              onChange={() => setSchema(prev => ({ ...prev, fallback: { ...prev.fallback, notifyOpsOnFailure: !prev.fallback.notifyOpsOnFailure } }))}
            />
            <span>Ops bei Fehler benachrichtigen</span>
          </label>
        </section>

        <section className="card p-4 space-y-3">
          <h4 className="text-sm font-bold text-slate-800">8) Agent druecken</h4>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
            <div>
              <label className="block text-xs font-semibold text-slate-600">Rolle</label>
              <input
                value={actorRole}
                onChange={(event) => setActorRole(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600">Actor ID</label>
              <input
                value={actorId}
                onChange={(event) => setActorId(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600">Access Token (optional)</label>
              <input
                value={accessToken}
                onChange={(event) => setAccessToken(event.target.value)}
                type="password"
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
          </div>
          <label className="block text-xs font-semibold text-slate-600">Dateien (Excel, Bilder, TSV/CSV)</label>
          <input
            type="file"
            multiple
            accept=".tsv,.csv,.txt,.json,.xlsx,.xls,image/*"
            onChange={(event) => {
              void handleFileChange(event.target.files);
            }}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
          <div className="rounded-lg bg-slate-50 p-2 text-xs text-slate-600 ring-1 ring-slate-200">
            Max 6 Dateien, jeweils bis 2 MB. TSV/CSV/Text werden als Vorschau geparsed, Bilder werden fuer Gemini multimodal uebergeben, Excel als Kontext-Anlage mit Metadaten.
          </div>
          {attachments.length > 0 && (
            <div className="rounded-lg bg-white p-2 text-xs text-slate-700 ring-1 ring-slate-200">
              {attachments.map(file => (
                <div key={`${file.name}-${file.sizeBytes}`} className="flex items-center justify-between gap-2 py-0.5">
                  <span className="truncate">{file.name}</span>
                  <span className="font-mono text-slate-500">{file.sizeBytes} B</span>
                </div>
              ))}
            </div>
          )}
          <label className="block text-xs font-semibold text-slate-600">Auftrag</label>
          <textarea
            value={objective}
            onChange={(event) => setObjective(event.target.value)}
            rows={3}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
          <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600 ring-1 ring-slate-200">
            Frag den Agent ruhig direkt als Mensch: Was ist fertig, was ist Mist, und was kann besser laufen? Der Lauf antwortet dann mit Urteil, Status und Verbesserungen.
          </div>
          {([
            ["defaultDryRun", "Default Dry Run"],
            ["allowPlanWrite", "Plan schreiben erlauben"],
            ["allowRackWrite", "Rack schreiben erlauben"],
            ["allowMailDraft", "Mail-Entwurf erlauben"],
          ] as Array<[keyof AgentActionRules, string]>).map(([key, label]) => (
            <label key={key} className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={schema.actions[key]}
                onChange={() => setSchema(prev => ({ ...prev, actions: { ...prev.actions, [key]: !prev.actions[key] } }))}
              />
              <span>{label}</span>
            </label>
          ))}
          <button disabled={isRunning} onClick={triggerAgent} className="mt-2 w-full rounded-lg bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-emerald-300">
            {isRunning ? "Agent antwortet ..." : "1) Agent fragen"}
          </button>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            <div>
              <label className="block text-xs font-semibold text-slate-600">Proposal ID</label>
              <input
                value={proposalId}
                onChange={(event) => setProposalId(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600">Approve Kommentar</label>
              <input
                value={approveComment}
                onChange={(event) => setApproveComment(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
          </div>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            <button disabled={isRunning} onClick={approveProposal} className="w-full rounded-lg bg-sky-700 px-4 py-2 text-sm font-bold text-white hover:bg-sky-600 disabled:cursor-not-allowed disabled:bg-sky-300">
              2) Approve speichern
            </button>
            <button disabled={isRunning} onClick={applyProposal} className="w-full rounded-lg bg-amber-600 px-4 py-2 text-sm font-bold text-white hover:bg-amber-500 disabled:cursor-not-allowed disabled:bg-amber-300">
              3) Apply schreiben
            </button>
          </div>
          <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600 ring-1 ring-slate-200">
            Pipeline: Dry-Run erstellt Proposal, Approve setzt Freigabe, Apply schreibt Plan/Rack nur mit Berechtigung und (falls aktiviert) Approval.
          </div>
        </section>
      </div>

      <div className="card p-4">
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-sm font-bold text-slate-800">Schema (JSON)</h4>
          <span className="text-xs text-slate-500">Direkt fuer Backend/API nutzbar</span>
        </div>
        <textarea
          readOnly
          value={schemaJson}
          rows={16}
          className="mt-3 w-full rounded-lg border border-slate-300 bg-slate-950 p-3 font-mono text-xs text-emerald-200"
        />
      </div>

      {lastResult && (
        <div className="card p-4 space-y-3 border border-slate-200">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-sm font-bold text-slate-800">Agent Antwort</h4>
            <span className={`rounded-full px-3 py-1 text-xs font-semibold ring-1 ${verdictTone(lastResult.verdict)}`}>
              {verdictLabel(lastResult.verdict)}
            </span>
          </div>
          <div className="rounded-lg bg-slate-50 p-3 text-sm text-slate-700 ring-1 ring-slate-200">
            {String(lastResult.status || lastResult.summary || "Keine Antwort.")}
          </div>
          {comparison && (
            <div className="rounded-lg bg-sky-50 p-3 text-xs text-sky-900 ring-1 ring-sky-200">
              <div className="font-semibold">Dual Compare</div>
              <div className="mt-1">{String(comparison.recommendation || "")}</div>
              <div className="mt-2 grid gap-2 md:grid-cols-2">
                <div className="rounded-md bg-white p-2 ring-1 ring-sky-100">
                  <div className="font-semibold">Primary</div>
                  <div>{String(asRecord(comparison.primary) ? `${String(asRecord(comparison.primary)?.provider || "")}/${String(asRecord(comparison.primary)?.model || "")}` : "")}</div>
                </div>
                <div className="rounded-md bg-white p-2 ring-1 ring-sky-100">
                  <div className="font-semibold">Secondary</div>
                  <div>{String(asRecord(comparison.secondary) ? `${String(asRecord(comparison.secondary)?.provider || "")}/${String(asRecord(comparison.secondary)?.model || "")}` : "")}</div>
                </div>
              </div>
            </div>
          )}
          {Array.isArray(lastResult.actions) && lastResult.actions.length > 0 && (
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Empfohlene Aktionen</div>
              <ul className="mt-2 space-y-1 text-sm text-slate-700">
                {lastResult.actions.slice(0, 5).map((item) => <li key={String(item)}>• {String(item)}</li>)}
              </ul>
            </div>
          )}
          {Array.isArray(lastResult.improvements) && lastResult.improvements.length > 0 && (
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Besser waere</div>
              <ul className="mt-2 space-y-1 text-sm text-slate-700">
                {lastResult.improvements.slice(0, 5).map((item) => <li key={String(item)}>• {String(item)}</li>)}
              </ul>
            </div>
          )}
          {Array.isArray(lastResult.questions) && lastResult.questions.length > 0 && (
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Rueckfragen</div>
              <ul className="mt-2 space-y-1 text-sm text-slate-700">
                {lastResult.questions.slice(0, 5).map((item) => <li key={String(item)}>• {String(item)}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
