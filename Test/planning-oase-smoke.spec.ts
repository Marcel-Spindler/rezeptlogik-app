import { expect, test } from "@playwright/test";

test.setTimeout(90000);
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";

// Planning OASE is down to 2 internal sections: "Plating Linien Planung" and
// "Rack". The former "Cockpit" (Drag&Drop-Wochenboard, PlanningView) is gone —
// the kitchen is planned backwards from the Plating-Plan + Cook Schedule in its
// own top-level "Kochplan" view (src/features/kitchen-plan/).

test("Planning OASE owns rack and line planning navigation", async ({ page }) => {
  await page.goto(`${BASE_URL}?view=planning`);
  await expect(page.getByText("Planning OASE").first()).toBeVisible({ timeout: 30000 });
  const oasisHeader = page.getByRole("heading", { name: "Planning OASE" }).first();
  const oasisCard = page.locator("div.card").filter({ has: oasisHeader }).first();

  // Default section = Plating Linien Planung.
  await expect(page.getByText("Plating Linien Planung").first()).toBeVisible();

  await oasisCard.getByRole("button", { name: "Rack" }).evaluate((element: HTMLButtonElement) => element.click());
  await expect(page.getByText("Rack v2")).toBeVisible();

  await oasisCard.getByRole("button", { name: "Plating Linien Planung" }).evaluate((element: HTMLButtonElement) => element.click());
  await expect(page.getByText("Plating Linien Planung").first()).toBeVisible();

  // The old "Cockpit" tab must not reappear.
  await expect(oasisCard.getByRole("button", { name: "Cockpit" })).toHaveCount(0);
});

test("stale ?oase deep links fall back to the default section without crashing", async ({ page }) => {
  for (const stale of ["cockpit", "wms", "mfg"]) {
    await page.goto(`${BASE_URL}?view=planning&oase=${stale}`);
    await expect(page.getByText("Planning OASE").first()).toBeVisible({ timeout: 30000 });
    await expect(page.getByText("Fehler beim Laden")).toHaveCount(0);
    await expect(page.getByText("Plating Linien Planung").first()).toBeVisible();
  }
});

test("oase deep links for the remaining sections render correctly", async ({ page }) => {
  await page.goto(`${BASE_URL}?view=planning&oase=rack`);
  await expect(page.getByText("Rack v2")).toBeVisible({ timeout: 30000 });

  await page.goto(`${BASE_URL}?view=planning&oase=lines`);
  await expect(page.getByText("Plating Linien Planung").first()).toBeVisible({ timeout: 30000 });
});

test("section switch writes the oase query param", async ({ page }) => {
  await page.goto(`${BASE_URL}?view=planning&oase=rack`);
  await expect(page.getByText("Rack v2")).toBeVisible({ timeout: 30000 });

  const oasisHeader = page.getByRole("heading", { name: "Planning OASE" }).first();
  const oasisCard = page.locator("div.card").filter({ has: oasisHeader }).first();

  await oasisCard.getByRole("button", { name: "Plating Linien Planung" }).click();
  await expect(page).toHaveURL(/oase=lines/);
  await expect(page.getByText("Plating Linien Planung").first()).toBeVisible();
});

test("Kochplan view loads and points at the Plating-Plan when none exists", async ({ page }) => {
  await page.goto(`${BASE_URL}?view=kochplan`);
  await expect(page.getByRole("heading", { name: /Kochplan/ })).toBeVisible({ timeout: 30000 });
  await expect(page.getByText("Fehler beim Laden")).toHaveCount(0);
});
