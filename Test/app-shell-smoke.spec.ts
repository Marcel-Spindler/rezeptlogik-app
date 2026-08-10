import { expect, test } from "@playwright/test";

test.setTimeout(90000);
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";

// Baseline "does the app still boot" check for the rebuilt src/app/ shell
// (AppContext, Router, Shell, NavTabs). Every rewrite phase should keep this green.

test("all 8 nav tabs render via deep link and highlight themselves in the sidebar", async ({ page }) => {
  const views: Array<[string, string]> = [
    ["recipe", "Rezept"],
    ["planning", "Planning OASE"],
    ["wo", "KET Plan / WO"],
    ["pet", "PET Plan / Plating"],
    ["wms", "WMS Übersicht"],
    ["whatif", "What-If Rechner"],
    ["rundmail", "Rundmail"],
    ["import", "CSV Import"],
  ];

  for (const [view, label] of views) {
    await page.goto(`${BASE_URL}?view=${view}`);
    const nav = page.locator("aside nav").first();
    await expect(nav).toBeVisible({ timeout: 30000 });
    // active tab is styled with bg-verden-600 — assert via the shared class rather than color
    await expect(nav.getByRole("button", { name: label, exact: true })).toHaveClass(/bg-verden-600/);
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
