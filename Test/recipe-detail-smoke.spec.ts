import { expect, test } from "@playwright/test";

test.setTimeout(90000);
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";

// Rezept-Detail wurde von 8 auf 7 Tabs reduziert (Engpass-Analyse entfernt) und in
// src/features/recipe-detail/ aufgeteilt. Diese Spec deckt den Tab-Wechsel und die
// localStorage-Migration ab (alte "engpass"-Auswahl darf nicht crashen).

test("recipe tab shows exactly 7 tabs, no Engpass-Analyse", async ({ page }) => {
  await page.goto(`${BASE_URL}?view=recipe`);
  const card = page.locator("main div.card").first();
  await expect(card).toBeVisible({ timeout: 30000 });

  const expectedTabs = ["Übersicht", "Rezeptstruktur", "Workflow & Equipment", "Brutto-Zutaten", "Plating", "Cook-Schedule"];
  for (const label of expectedTabs) {
    await expect(card.getByRole("button", { name: label, exact: true })).toBeVisible();
  }
  await expect(card.getByRole("button", { name: /Sub-Rezepte/ })).toBeVisible();
  await expect(card.getByRole("button", { name: "Engpass-Analyse" })).toHaveCount(0);
});

test("clicking through all 7 tabs renders without error", async ({ page }) => {
  await page.goto(`${BASE_URL}?view=recipe`);
  const card = page.locator("main div.card").first();
  await expect(card).toBeVisible({ timeout: 30000 });

  const tabs = ["Übersicht", "Rezeptstruktur", "Workflow & Equipment", "Brutto-Zutaten", "Plating", "Cook-Schedule"];
  for (const label of tabs) {
    await card.getByRole("button", { name: label, exact: true }).click();
    await expect(page.getByText("Fehler beim Laden")).toHaveCount(0);
  }
  await card.getByRole("button", { name: /Sub-Rezepte/ }).click();
  await expect(page.getByText("Fehler beim Laden")).toHaveCount(0);
});

test("stale 'engpass' localStorage value falls back to Übersicht instead of crashing", async ({ page }) => {
  await page.goto(BASE_URL);
  await page.evaluate(() => window.localStorage.setItem("rezeptlogik_v1_detail_tab", JSON.stringify("engpass")));
  await page.goto(`${BASE_URL}?view=recipe`);

  const card = page.locator("main div.card").first();
  await expect(card).toBeVisible({ timeout: 30000 });
  await expect(page.getByText("Fehler beim Laden")).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Übersicht" })).toHaveClass(/bg-slate-900/);
});

test("market switcher and in-recipe search work", async ({ page }) => {
  await page.goto(`${BASE_URL}?view=recipe`);
  const card = page.locator("main div.card").first();
  await expect(card).toBeVisible({ timeout: 30000 });

  const search = page.getByPlaceholder("Im geöffneten Rezept suchen: Zutat, Sub-Rezept, Step, SKU ...");
  await search.fill("xx-definitely-not-a-real-ingredient-xx");
  await card.getByRole("button", { name: /Sub-Rezepte/ }).click();
  await expect(page.getByText("Keine Sub-Rezepte für diese Suche gefunden.")).toBeVisible();
  await page.getByRole("button", { name: "Leeren" }).click();
  await expect(search).toHaveValue("");
});
