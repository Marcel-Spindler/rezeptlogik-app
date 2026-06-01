import { expect, test } from "@playwright/test";

test.setTimeout(90000);
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";

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

  await oasisCard.getByRole("button", { name: "Breakdown+" }).evaluate((element: HTMLButtonElement) => element.click());
  await expect(page.getByText("Breakdown Rechner")).toBeVisible();

  await oasisCard.getByRole("button", { name: "Cockpit" }).evaluate((element: HTMLButtonElement) => element.click());
  await expect(page.getByText("Manufacturing Planning Calendar")).toBeVisible();
});

test("oase deep links for sections render correctly", async ({ page }) => {
  await page.goto(`${BASE_URL}?view=planning&oase=rack`);
  await expect(page.getByText("Rack v2")).toBeVisible({ timeout: 30000 });

  await page.goto(`${BASE_URL}?view=planning&oase=lines`);
  await expect(page.getByText("Plating Linien Plannung").first()).toBeVisible({ timeout: 30000 });

  await page.goto(`${BASE_URL}?view=planning&oase=breakdown`);
  await expect(page.getByText("Breakdown Rechner")).toBeVisible({ timeout: 30000 });
});

test("Planning OASE supports section deep links", async ({ page }) => {
  await page.goto(`${BASE_URL}?view=planning&oase=rack`);
  await expect(page.getByText("Rack v2")).toBeVisible({ timeout: 30000 });

  const oasisHeader = page.getByRole("heading", { name: "Planning OASE" }).first();
  const oasisCard = page.locator("div.card").filter({ has: oasisHeader }).first();

  await oasisCard.getByRole("button", { name: "Breakdown+" }).click();
  await expect(page).toHaveURL(/oase=breakdown/);
  await expect(page.getByText("Breakdown Rechner")).toBeVisible();

  await oasisCard.getByRole("button", { name: "WMS Live" }).click();
  await expect(page).toHaveURL(/oase=wms/);
  await expect(page.getByText("WMS Live Prozess-Dashboard")).toBeVisible();
});

test("Planning OASE cockpit renders on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE_URL}?view=planning&oase=cockpit`);
  await expect(page.getByText("Planning OASE").first()).toBeVisible({ timeout: 30000 });
  await expect(page.getByText("App Data: ok")).toBeVisible({ timeout: 30000 });
  await expect(page.getByText("Manufacturing Planning Calendar")).toBeVisible();
});

test("Breakdown raw calculator screen renders", async ({ page }) => {
  await page.goto(`${BASE_URL}?view=planning&oase=breakdown`);
  await expect(page.getByText("Breakdown Rechner")).toBeVisible({ timeout: 30000 });
  await expect(page.getByRole("button", { name: "Mahlzeit hinzufügen" }).first()).toBeVisible();
  await expect(page.getByText("Rohwaren-Szenario").first()).toBeVisible();
});
