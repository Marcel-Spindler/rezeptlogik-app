import { expect, test } from "@playwright/test";

test.setTimeout(90000);
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";

// Planning OASE was trimmed from 8 internal sections down to 3 (cockpit/lines/rack) —
// mfg, breakdown, wms, recipes and agent were removed. This spec only covers what's left.

test("Planning OASE owns rack and line planning navigation", async ({ page }) => {
  await page.goto(`${BASE_URL}?view=planning`);
  await expect(page.getByText("Planning OASE").first()).toBeVisible({ timeout: 30000 });
  const oasisHeader = page.getByRole("heading", { name: "Planning OASE" }).first();
  const oasisCard = page.locator("div.card").filter({ has: oasisHeader }).first();

  const nav = page.locator("aside").first();
  await expect(nav.getByRole("button", { name: "Breakdown+" })).toHaveCount(0);
  await expect(nav.getByRole("button", { name: "Rack" })).toHaveCount(0);
  await expect(nav.getByRole("button", { name: "Linien-Fokus" })).toHaveCount(0);

  await expect(oasisCard.getByRole("button", { name: "Rack" })).toBeVisible();
  await oasisCard.getByRole("button", { name: "Rack" }).evaluate((element: HTMLButtonElement) => element.click());
  await expect(page.getByText("Rack v2")).toBeVisible();

  await oasisCard.getByRole("button", { name: "Linienplanung" }).evaluate((element: HTMLButtonElement) => element.click());
  await expect(page.getByText("Plating Linien Plannung").first()).toBeVisible();

  await oasisCard.getByRole("button", { name: "Cockpit" }).evaluate((element: HTMLButtonElement) => element.click());
  await expect(page.getByText("Manufacturing Planning Calendar")).toBeVisible();
});

test("removed sections no longer have nav buttons or deep links", async ({ page }) => {
  await page.goto(`${BASE_URL}?view=planning`);
  const oasisHeader = page.getByRole("heading", { name: "Planning OASE" }).first();
  const oasisCard = page.locator("div.card").filter({ has: oasisHeader }).first();
  await expect(oasisCard).toBeVisible({ timeout: 30000 });

  for (const label of ["Küchen-Kalender", "Breakdown+", "WMS Live", "Rezept-Fokus", "Agent Setup"]) {
    await expect(oasisCard.getByRole("button", { name: label })).toHaveCount(0);
  }

  // A stale ?oase=wms deep link (from before the trim) must not crash the page —
  // it should just fall back to the default section.
  await page.goto(`${BASE_URL}?view=planning&oase=wms`);
  await expect(page.getByText("Planning OASE").first()).toBeVisible({ timeout: 30000 });
  await expect(page.getByText("Fehler beim Laden")).toHaveCount(0);
});

test("oase deep links for the remaining sections render correctly", async ({ page }) => {
  await page.goto(`${BASE_URL}?view=planning&oase=rack`);
  await expect(page.getByText("Rack v2")).toBeVisible({ timeout: 30000 });

  await page.goto(`${BASE_URL}?view=planning&oase=lines`);
  await expect(page.getByText("Plating Linien Plannung").first()).toBeVisible({ timeout: 30000 });

  await page.goto(`${BASE_URL}?view=planning&oase=cockpit`);
  await expect(page.getByText("Manufacturing Planning Calendar")).toBeVisible({ timeout: 30000 });
});

test("Planning OASE supports section deep links via URL", async ({ page }) => {
  await page.goto(`${BASE_URL}?view=planning&oase=rack`);
  await expect(page.getByText("Rack v2")).toBeVisible({ timeout: 30000 });

  const oasisHeader = page.getByRole("heading", { name: "Planning OASE" }).first();
  const oasisCard = page.locator("div.card").filter({ has: oasisHeader }).first();

  await oasisCard.getByRole("button", { name: "Linienplanung" }).click();
  await expect(page).toHaveURL(/oase=lines/);
  await expect(page.getByText("Plating Linien Plannung").first()).toBeVisible();
});

test("Planning OASE cockpit renders on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE_URL}?view=planning&oase=cockpit`);
  await expect(page.getByText("Planning OASE").first()).toBeVisible({ timeout: 30000 });
  await expect(page.getByText("App Data: ok")).toBeVisible({ timeout: 30000 });
  await expect(page.getByText("Manufacturing Planning Calendar")).toBeVisible();
});

// Cockpit-Linie V2 / Batch-Split Automatik / Schema-Planung cards were removed in
// 037d278 (replaced by the KI-Planungsassistent panel) — this spec now covers that.
test("KI-Planungsassistent panel opens from the cockpit toolbar", async ({ page }) => {
  await page.goto(`${BASE_URL}?view=planning&oase=cockpit`);
  await expect(page.getByText("Manufacturing Planning Calendar")).toBeVisible({ timeout: 30000 });
  await page.getByRole("button", { name: "KI-Assistent" }).click();
  await expect(page.getByText("KI-Planungsassistent")).toBeVisible();
});
