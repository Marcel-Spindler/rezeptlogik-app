import { expect, test } from "@playwright/test";

test.setTimeout(90000);
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";

// Baseline "does the app still boot" check for the rebuilt src/app/ shell
// (AppContext, Router, Shell, NavTabs). Every rewrite phase should keep this green.

test("all nav categories render via deep link and highlight themselves in the sidebar", async ({ page }) => {
  // catLabel = the NavTabs category button that should be highlighted.
  // itemLabel = the entry inside that category's flyout that should be highlighted.
  const views: Array<[string, string, string]> = [
    ["recipe", "Rezepte & Meals", "Rezept"],
    ["catalog", "Rezepte & Meals", "Meal Katalog"],
    ["planning", "Wochenplanung", "Planning OASE"],
    ["artikel-woche", "Wochenplanung", "Artikel / KW"],
    ["whatif", "Wochenplanung", "What-If Rechner"],
    ["wo", "Produktion", "KET Plan / WO"],
    ["pet", "Produktion", "PET Plan / Plating"],
    ["wms", "Lager & WMS", "WMS Übersicht"],
    ["full-inventory", "Lager & WMS", "Lager Komplett"],
    ["postblast-live", "Live-Monitoring", "Postblast Live"],
    ["backfills", "Live-Monitoring", "Backfills"],
    ["transparency-plan", "Live-Monitoring", "Transparency Plan"],
    // Redzone Live is dev-only (needs the local WMS/Snowflake server) — valid to test
    // here since these specs always run against a local dev server.
    ["redzone-live", "Live-Monitoring", "Redzone Live"],
    ["blast-chiller", "Bots", "Blast Chiller"],
    ["allergen-plating", "Bots", "Allergen Plating"],
    ["rundmail", "Kommunikation", "Rundmail"],
    ["import", "Kommunikation", "CSV Import"],
  ];

  for (const [view, catLabel, itemLabel] of views) {
    await page.goto(`${BASE_URL}?view=${view}`);
    // "aside nav" for the standard shell, but the bundled "Bots" views
    // (blast-chiller, allergen-plating) render NavTabs full-width without the aside wrapper.
    const nav = page.locator("nav").first();
    await expect(nav).toBeVisible({ timeout: 30000 });
    // active tab is styled with bg-verden-600 — assert via the shared class rather than color
    const catButton = nav.getByRole("button", { name: catLabel, exact: true });
    await expect(catButton).toHaveClass(/bg-verden-600/);
    await catButton.hover();
    await expect(nav.getByRole("button", { name: itemLabel, exact: true })).toHaveClass(/bg-verden-600/);
    await expect(page.locator("main").first()).toBeVisible();
  }
});

test("kitchen mode surface renders without the tab sidebar", async ({ page }) => {
  await page.goto(`${BASE_URL}?surface=kitchen`);
  await expect(page.getByText("Küchenmodus")).toBeVisible({ timeout: 30000 });
  await expect(page.locator("aside nav")).toHaveCount(0);
});

test("rundmail surface renders without the tab sidebar", async ({ page }) => {
  await page.goto(`${BASE_URL}?surface=rundmail`);
  await expect(page.locator("aside nav")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("Fehler beim Laden");
});

test("week deep link overrides the selected week", async ({ page }) => {
  await page.goto(BASE_URL);
  const weekSelect = page.locator("aside select").first();
  await expect(weekSelect).toBeVisible({ timeout: 30000 });
  const someWeek = await weekSelect.locator("option").nth(1).getAttribute("value");
  test.skip(!someWeek, "not enough weeks loaded to test deep-link override");
  await page.goto(`${BASE_URL}?week=${someWeek}`);
  await expect(weekSelect).toHaveValue(someWeek!, { timeout: 30000 });
});
