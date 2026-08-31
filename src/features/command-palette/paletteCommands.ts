// Command-Palette — die App-Kommando-Registry.
//
// Bewusst schmal + client-seitig: Deploy/Sync sind Terminal-npm-Skripte und
// gehören NICHT hierher. Neue Kommandos einfach als weiteren Eintrag anhängen.
import type { AppView } from "../../app/AppContext";
import { buildKitchenShareUrl } from "../../lib/helpers";
import { GROUP_ICON, type PaletteItem } from "./paletteTypes";
import { GROUP_PRIORITY } from "./paletteSource";

export interface CommandContext {
  view: AppView;
  selectedWeek: string;
  upliftPercent: number;
  setUpliftPercent: (pct: number) => void;
}

const UPLIFT_MIN = -10;
const UPLIFT_MAX = 30;
const clampUplift = (n: number) => Math.max(UPLIFT_MIN, Math.min(UPLIFT_MAX, n));

async function copy(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

function cmd(
  key: string,
  title: string,
  subtitle: string,
  search: string,
  run: () => void | string | Promise<void | string>,
): PaletteItem {
  return {
    key: `cmd:${key}`,
    group: "command",
    title,
    subtitle,
    hint: "Kommando",
    icon: GROUP_ICON.command,
    search: `${title} ${subtitle} ${search}`.toLowerCase(),
    priority: GROUP_PRIORITY.command,
    action: { type: "run", run },
  };
}

export function buildCommandItems(ctx: CommandContext): PaletteItem[] {
  const upliftNow = `${ctx.upliftPercent > 0 ? "+" : ""}${ctx.upliftPercent} %`;
  return [
    cmd(
      "uplift-plus",
      "Uplift +5 %",
      `aktuell ${upliftNow}`,
      "verden erhoehen hochsetzen portionen",
      () => {
        ctx.setUpliftPercent(clampUplift(ctx.upliftPercent + 5));
        return `Uplift ${clampUplift(ctx.upliftPercent + 5) > 0 ? "+" : ""}${clampUplift(ctx.upliftPercent + 5)} %`;
      },
    ),
    cmd(
      "uplift-minus",
      "Uplift −5 %",
      `aktuell ${upliftNow}`,
      "verden senken runtersetzen portionen",
      () => {
        ctx.setUpliftPercent(clampUplift(ctx.upliftPercent - 5));
        return `Uplift ${clampUplift(ctx.upliftPercent - 5) > 0 ? "+" : ""}${clampUplift(ctx.upliftPercent - 5)} %`;
      },
    ),
    cmd("uplift-reset", "Uplift auf 0 % zurücksetzen", `aktuell ${upliftNow}`, "verden reset null", () => {
      ctx.setUpliftPercent(0);
      return "Uplift zurückgesetzt";
    }),
    cmd(
      "kitchen-open",
      "Küchen-Ansicht öffnen",
      `KW ${ctx.selectedWeek || "–"} · neuer Tab`,
      "kitchen mode shopfloor kueche tablet",
      () => {
        window.open(buildKitchenShareUrl(ctx.selectedWeek), "_blank", "noopener");
      },
    ),
    cmd(
      "kitchen-copy",
      "Küchen-Link kopieren",
      `KW ${ctx.selectedWeek || "–"}`,
      "kitchen mode link teilen url zwischenablage",
      async () => {
        await copy(buildKitchenShareUrl(ctx.selectedWeek));
        return "✓ Küchen-Link kopiert";
      },
    ),
    cmd(
      "share-view",
      "Diese Ansicht als Link kopieren",
      `${ctx.view} · KW ${ctx.selectedWeek || "–"}`,
      "deep link url teilen zwischenablage bookmarklet",
      async () => {
        const url = new URL(window.location.href);
        url.searchParams.set("view", ctx.view);
        if (ctx.selectedWeek) url.searchParams.set("week", ctx.selectedWeek);
        await copy(url.toString());
        return "✓ Link kopiert";
      },
    ),
    cmd("reload", "Daten neu laden", "App-Reload", "refresh aktualisieren firestore neu", () => {
      window.location.reload();
    }),
  ];
}
