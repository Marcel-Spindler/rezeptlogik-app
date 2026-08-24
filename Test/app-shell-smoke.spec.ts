import { expect, test } from "@playwright/test";

test.setTimeout(90000);
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";

// Baseline "does the app still boot" check for the rebuilt src/app/ shell
// (AppContext, Router, Shell, NavTabs). Every rewrite phase should keep this green.

test("all nav groups render via deep link and highlight themselves in the sidebar", async ({ page }) => {
  // navLabel = the NavTabs entry that should be highlighted. subLabel = the
  // GroupSubTabs entry (only present for views bundled into "Bots"/"Monitoring").
  const views: Array<[string, string, string?]> = [
    ["recipe", "Rezept"],
    ["catalog", "Meal Katalog"],
    ["planning", "Planning OASE"],
    ["wo", "KET Plan / WO"],
    ["pet", "PET Plan / Plating"],
    ["wms", "WMS Übersicht"],
    ["whatif", "What-If Rechner"],
    ["rundmail", "Rundmail"],
    ["import", "CSV Import"],
    ["blast-chiller", "Bots", "Blast Chiller"],
    ["allergen-plating", "Bots", "Allergen Plating"],
    ["postblast-live", "Monitoring", "Postblast Live"],
    ["backfills", "Monitoring", "Backfills"],
    // Redzone Live is dev-only (needs the local WMS/Snowflake server) — valid to test
    // here since these specs always run against a local dev server.
    ["redzone-live", "Redzone Live"],
  ];

  for (const [view, navLabel, subLabel] of views) {
    await page.goto(`${BASE_URL}?view=${view}`);
    // "aside nav" for the standard shell, but the bundled "Bots" views
    // (blast-chiller, allergen-plating) render NavTabs full-width without the aside wrapper.
    const nav = page.locator("nav").first();
    await expect(nav).toBeVisible({ timeout: 30000 });
    // active tab is styled with bg-verden-600 — assert via the shared class rather than color
    await expect(nav.getByRole("button", { name: navLabel, exact: true })).toHaveClass(/bg-verden-600/);
    if (subLabel) {
      await expect(page.locator("main").first().getByRole("button", { name: subLabel, exact: true })).toHaveClass(/bg-verden-600/);
    }
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
