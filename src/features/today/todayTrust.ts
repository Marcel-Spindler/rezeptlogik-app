import type { DataSourceStatus } from "../../core/dataSource";

export type TrustLevel = "trusted" | "limited" | "offline";

export interface TodayTrust {
  level: TrustLevel;
  label: string;
  detail: string;
}

export function buildTodayTrust(
  source: DataSourceStatus,
  signals: { postblast: boolean; preblast: boolean; rti: boolean; linePlating: boolean; wmsHolding: boolean },
): TodayTrust {
  const connected = Object.values(signals).filter(Boolean).length;
  const liveDetail = `${connected}/5 Live-Signale verbunden`;

  if (source.error || source.kind === "json-fallback") {
    return { level: "offline", label: "Planquelle eingeschränkt", detail: `${source.label} · ${liveDetail}` };
  }
  if (source.kind === "firestore-cache" || connected < 4) {
    return { level: "limited", label: "Entscheidungsbasis eingeschränkt", detail: `${source.label} · ${liveDetail}` };
  }
  return { level: "trusted", label: "Entscheidungsbasis aktuell", detail: `${source.label} · ${liveDetail}` };
}