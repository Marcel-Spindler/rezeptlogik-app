import { describe, expect, it } from "vitest";
import { parseRti } from "../features/gsheet-monitor/parsers/parseRti";

// Header-Zeile + je Meal ein FV-Block. Spaltenbelegung der Sub-Zeilen:
// A WO · B Sub · C Holding Kg · D RTI Plating Kg · E 1 Meal gram ·
// F Availble Mealcount · G Minimum need · H % · I Backfill Meals · J Status
const ROWS: string[][] = [
  ["KW38 ", "", "", "Planned Target", "Actuals", "Delta", "%"],
  ["", "FV4048A - Creamy Leek Pork tenderloin [DE]", "", "3,763", "2,848", "-915", "24.32%"],
  ["WO's:", "Subrecipes:", "Plating holding Kg"],
  ["38-161", "Creamy Leek -Low Fat (Creamier)", "", "97.31", "100", "974", "59", "1.57%", "", ""],
  ["38-163", "Mash - Creamy Sweet Potato Puree (more salt)", "", "0", "95", "0", "-915", "-24.32%", "-1137", "done"],
  ["38-165", "Mash - Creamy Sweet Potato Puree (more salt)", "", "", "95", "0", "-915", "-24.32%", "-1137", ""],
  ["", "", ""],
  ["", "[DE] - FV1351A - Cheddar & Red Pepper Chicken Thigh Pasta", "", "5,402", "4,448", "-954", "17.66%"],
  ["WO's:", "Subrecipes:", "Plating holding Kg"],
  ["38-002", "Low Fat Red Pepper Fondue", "", "0", "40", "0", "-954", "-17.66%", "-1122", "no"],
];

describe("parseRti", () => {
  const data = parseRti(ROWS);

  it("liest die KW und beide Meal-Blöcke (auch den mit '[DE] - FV…'-Präfix)", () => {
    expect(data.week).toBe("W38");
    expect(data.meals.map(m => m.mealCode)).toEqual(["FV4048A", "FV1351A"]);
  });

  it("strippt das '[DE] - '-Präfix aus dem Meal-Namen", () => {
    expect(data.meals[1].mealName).toBe("Cheddar & Red Pepper Chicken Thigh Pasta");
    expect(data.meals[0].mealName).toBe("Creamy Leek Pork tenderloin");
  });

  it("mappt Planned Target / Actuals der Meal-Kopfzeile", () => {
    expect(data.meals[0].plannedTarget).toBe(3763);
    expect(data.meals[0].actuals).toBe(2848);
  });

  it("mappt die Sub-Rezept-Spalten D–I korrekt", () => {
    const mash = data.meals[0].subRecipes.find(s => s.workOrder === "38-163")!;
    expect(mash.weighedKg).toBe(0);
    expect(mash.gramPerMeal).toBe(95);
    expect(mash.availableMealcount).toBe(0);
    expect(mash.minimumNeed).toBe(-915);
    expect(mash.backfillMeals).toBe(-1137);
    expect(mash.status).toBe("done");
  });

  it("nimmt den Status NUR aus Spalte J — die Zahl in Spalte I ist kein Status", () => {
    const leek = data.meals[0].subRecipes.find(s => s.workOrder === "38-161")!;
    expect(leek.status).toBe("open"); // Spalte J leer
  });

  it("markiert die zweite Zeile desselben Sub-Rezepts als Backfill-Kandidat", () => {
    const rows163 = data.meals[0].subRecipes.filter(s => s.subRecipeName.startsWith("Mash"));
    expect(rows163.map(s => s.isBackfillCandidate)).toEqual([false, true]);
  });

  it("erkennt Status 'no'", () => {
    expect(data.meals[1].subRecipes[0].status).toBe("not-needed");
  });
});
