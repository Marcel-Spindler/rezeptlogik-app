import { describe, expect, it } from "vitest";
import { parseLinePlaiting } from "../features/gsheet-monitor/parsers/parseLinePlaiting";

// ── Fixtures: echte Spalten-Layouts der "LinePlating W{XX}"-Tabs ───────────────
// Die Positionen wandern von KW zu KW — der Parser muss die Spalten über die
// Header-Namen je Tagesblock finden, nicht über feste Indizes.

// W36-Layout: Code@9, Meal@10, Planned@11, Start/Stop/RunTime@12-14, Actual@15,
// Delta@16, "{Tag} needs"@17, Shortage@19, Shortage in %@20.
const W36: string[][] = [
  ["", "", "W36"],
  ["Day", "", "Time", "P-Line 1", "P-Line 2", "P-Line 3", "Cupping/Slicing"],
  // Montag-Block (keine Plating-Daten)
  ["", "Comms", "Montag", "Line 1", "Line 2", "Line 3", "Cupping/Slicing", "Amount", "", "Code", "Meal", "Planned", "Start", "Stop", "Run Time", "Actual", "Delta", "THU needs", "", "Shortage", "Shortage in %", "", "Labour Planning"],
  ["Monday", "Prep Line", "06:00 - 06:30", "Prepping", "Prepping", "Prepping", "", "", "", "FV4009A", "Salmon with mustard-dill sauce", "5499", "", "", "5.0", "0", "-5499", "", "", "", "100.00%"],
  // Dienstag-Block
  ["", "Comms", "Dienstag", "Line 1", "Line 2", "Line 3", "Cupping/Slicing", "Amount", "Awaiting Del", "Code", "Meal", "Planned", "Start", "Stop", "Run Time", "Actual", "Delta", "THU needs", "", "Shortage", "Shortage in %", "", "Labour Planning"],
  ["Tuesday", "Prep Line", "06:00 - 06:30", "Prepping", "Prepping", "Prepping", "", "", "1", "FV4034A", "Pulled chicken in smokey tomato sauce", "5,485", "", "", "5.0", "5168", "-317", "", "", "Potatoes and Chicken", "5.78%"],
  ["", "", "08:00 - 08:30", "", "", "", "", "", "1", "FV0478A", "Chickpea Curry", "1,433", "", "", "1.0", "1056", "-377", "", "", "Rice - recipe was wrong, too much water", "26.31%"],
  ["", "Clean Line", "14:45 - 15:00", "Clean Line", "Clean Line", "Clean Line", "", "", "", "", "", "26,708", "", "", "21.0", "15264", "-11444", "", "", "", "42.85%"],
  // Donnerstag-Block ("{Tag} needs" gefüllt)
  ["", "Comms", "Donnerstag", "Line 1", "Line 2", "Line 3", "Cupping/Slicing", "Amount", "", "Code", "Meal", "Planned", "Start", "Stop", "Run Time", "Actual", "Delta", "THU needs", "", "", "Shortage in %", "", "Labour Planning"],
  ["Thursday", "Prep Line", "06:00 - 06:30", "Prepping", "Prepping", "Prepping", "", "", "", "FV4034A", "Pulled chicken in smokey tomato sauce", "2500", "", "", "2.0", "2000", "-500", "400", "", "", "20.00%"],
  // Freitag-Block (Status-Text in der %-Spalte)
  ["", "Comms", "Freitag", "Line 1", "Line 2", "Line 3", "Cupping/Slicing", "Amount", "", "Code", "Meal", "Planned", "Start", "Stop", "Run Time", "Actual", "Delta", "FRI needs", "", "Comments", "Shortage in %", "", "Labour Planning"],
  ["Friday", "Prep Line", "09:00 - 09:30", "", "", "", "", "", "", "FV1942A", "Tandoori-Spiced Salmon Bowl", "3650", "", "", "3.0", "880", "-2770", "850", "", "", "blocked WO235"],
  // Samstag-Block ("{Tag} needs" = "done" statt Zahl)
  ["", "Comms", "Samstag", "Line 1", "Line 2", "Line 3", "Cupping/Slicing", "Amount", "", "Code", "Meal", "Planned", "Start", "Stop", "Run Time", "Actual", "Delta", "SAT needs", "", "Comments", "Shortage in %", "", "Labour Planning"],
  ["Saturday", "Prep Line", "06:00 - 06:30", "", "", "", "", "", "", "FV4034A", "Pulled chicken in smokey tomato sauce", "2050", "", "", "2.0", "2272", "222", "done", "", "", "-10.83%"],
];

// W35-Layout: eine Spalte weiter rechts, mit "Comment"@19 + "Backfills"@20
// (gemischte Zelle "yes" / "Min: 260"), Shortage@22, Shortage in %@23.
const W35: string[][] = [
  [" ", "", "W35"],
  ["Day", "", "Time", "P-Line 1", "P-Line 2", "P-Line 3", "Cupping/Slicing"],
  ["", "Comms", "", "Line 1", "Line 2", "Line 3", "Cupping/Slicing", "", "Amount", "Run", "Code", "Meal", "Planned", "Start", "Stop", "Run Time", "Actual", "Delta", "", "Comment", "Backfills", "", "Shortage", "Shortage in %", "", "Labour Planning"],
  ["Tuesday", "Prep Line", "06:30 - 07:00", "", "", "", "", "", "", "1", "FV0713A", "Cabbage in cheese sauce", "1000", "", "", "1.0", "800", "-200", "", "", "yes", "", "Peppers short", "20.00%"],
  ["", "Comms", "", "Line 1", "Line 2", "Line 3", "Cupping/Slicing", "", "Amount", "Run", "Code", "Meal", "Planned", "Start", "Stop", "Run Time", "Actual", "Delta", "", "Comment", "Backfills", "", "Shortage", "Shortage in %", "", "Labour Planning"],
  ["Friday", "Prep Line", "07:00 - 07:30", "", "", "", "", "", "", "", "FV0713A", "Cabbage in cheese sauce", "1200", "", "", "1.0", "50", "-1150", "", "", "Min: 260", "", "Peppers short", "21.00%"],
];

// W34-Layout: Code@9 … Actual@15, Delta@16, Tuesday-Block-Header "Min Needs THU"@17.
const W34: string[][] = [
  ["3", "", "W34"],
  ["Day", "", "Time", "P-Line 1", "P-Line 2", "P-Line 3", "Cupping/Slicing"],
  ["", "Comms", "", "Line 1", "Line 2", "Line 3", "Cupping/Slicing", "Amount", "Run", "Code", "Meal", "Planned", "Start", "Stop", "Run Time", "Actual", "Delta", "Min Needs THU", "", "Comment", "Backfills", "", "Shortage", "Shortage in %", "", "Labour Planning"],
  ["Thursday", "Prep Line", "06:30", "", "", "", "", "", "", "FV0576A", "Creamy Lemon Pepper", "3438", "", "", "3.0", "2048", "-1390", "1200", "", "", "", "", "Rosemary Carrot short", "40.00%"],
];

// gviz-CSV-Realität (Live-Poller): der gviz-Export merged die obersten Zeilen zu
// EINER voll beschrifteten Header-Zeile (Spalte 1 == "Comms") und lässt bei den
// Wiederhol-Blöcken die Header numerischer Spalten (Planned/Actual/Delta/{Tag}
// needs/Shortage in %) WEG. Der Parser muss die Spalten-Map über alle "Comms"-
// Zeilen mergen.
const W36_GVIZ: string[][] = [
  // gemergte Kopfzeile — voll beschriftet, Spalte 1 = "Comms"
  ["Day ", "Comms", "W36 Time Montag", "P-Line 1 Line 1", "P-Line 2 Line 2", "P-Line 3 Line 3", "Cupping/Slicing", "Amount", "", "Code", "Meal", "Planned", "Start", "Stop", "Run Time", "Actual", "Delta", "THU needs", "", "Shortage", "Shortage in %", "", "Labour Planning"],
  ["Monday", "Prep Line", "06:00 - 06:30", "Prepping", "Prepping", "Prepping", "", "", "", "FV4009A", "Salmon with mustard-dill sauce", "5499", "", "", "5.0", "0", "-5499", "", "", "", "100.00%"],
  // Dienstag-Comms: numerische Header von gviz entfernt (Spalten 11/15/16/17/20 leer)
  ["", "Comms", "Dienstag", "Line 1", "Line 2", "Line 3", "Cupping/Slicing", "Amount", "", "Code", "Meal", "", "Start", "Stop", "", "", "", "", "", "Shortage", "", "", "Labour Planning"],
  ["Tuesday", "Prep Line", "06:00 - 06:30", "Prepping", "Prepping", "Prepping", "", "", "1", "FV4034A", "Pulled chicken in smokey tomato sauce", "5,485", "", "", "5.0", "5168", "-317", "", "", "Potatoes and Chicken", "5.78%"],
  ["", "", "08:00 - 08:30", "", "", "", "", "", "1", "FV0478A", "Chickpea Curry", "1,433", "", "", "1.0", "1056", "-377", "", "", "Rice recipe wrong", "26.31%"],
  ["", "Clean Line", "14:45 - 15:00", "Clean Line", "Clean Line", "Clean Line", "", "", "", "", "", "26,708", "", "", "21.0", "15264", "-11444", "", "", "", "42.85%"],
  // Freitag-Comms: Spalte 19 wird zu "Comments" umbenannt
  ["", "Comms", "Freitag", "Line 1", "Line 2", "Line 3", "Cupping/Slicing", "Amount", "", "Code", "Meal", "", "Start", "Stop", "", "", "", "", "", "Comments", "", "", "Labour Planning"],
  ["Friday", "Prep Line", "09:00 - 09:30", "", "", "", "", "", "", "FV1942A", "Tandoori-Spiced Salmon Bowl", "3650", "", "", "3.0", "880", "-2770", "850", "", "done , no carrots", ""],
];

// W38-Layout: das Sheet lässt die Planned/Actual/Delta-Header GANZ weg (auch in
// der ersten Comms-Zeile), die Spalten stehen aber weiter an der W36-Geometrie
// relativ zu "Meal": Meal@10, Planned@11, Start@12, Stop@13, RunTime@14,
// Actual@15, Delta@16, "THU needs"@17.
const W38: string[][] = [
  ["", "", "W38"],
  ["", "Comms", "Dienstag", "Line 1", "Line 2", "Line 3", "Cupping/Slicing", "Amount", "", "Code", "Meal", "", "Start", "Stop", "", "", "", "THU needs", "", "Shortage", "Comments"],
  ["Tuesday", "Prep Line", "06:00 - 06:30", "Prepping", "Prepping", "Prepping", "", "", "", "FV1351A", "Cheddar & Red Pepper Chicken Thigh Pasta", "5402", "", "", "5.0", "4448", "-954", "", "", "Fondue short", "Ready"],
  ["", "", "07:00 - 07:30", "", "", "", "", "", "", "FV0516A", "Sun-Dried Tomato Penne", "1810", "", "", "1.0", "1712", "-98", "", "", "Spinach short", "Ready"],
  ["", "Comms", "Donnerstag", "Line 1", "Line 2", "Line 3", "Cupping/Slicing", "Amount", "", "Code", "Meal", "", "Start", "Stop", "", "", "", "THU needs", "", "Shortage", "Comments"],
  ["Thursday", "Prep Line", "06:00 - 06:30", "", "", "", "", "", "", "FV1351A", "Cheddar & Red Pepper Chicken Thigh Pasta", "2233", "", "", "2.0", "512", "-1721", "900", "", "", ""],
];

describe("parseLinePlaiting — W38 ohne Planned/Actual/Delta-Header (positionaler Fallback)", () => {
  it("liest planned/actual/delta über die W36-Geometrie relativ zu 'Meal'", () => {
    const data = parseLinePlaiting(W38);
    expect(data.week).toBe("W38");
    const tue = data.rows.find(r => r.day === "Tuesday" && r.recipeCode === "FV1351A")!;
    expect(tue.plannedPortions).toBe(5402);
    expect(tue.actualPortions).toBe(4448);
    expect(tue.deltaPortions).toBe(-954);
    const penne = data.rows.find(r => r.recipeCode === "FV0516A")!;
    expect(penne.plannedPortions).toBe(1810);
    expect(penne.actualPortions).toBe(1712);
  });

  it("summiert Actuals eines Meals über mehrere Tage (byRecipeCode)", () => {
    const data = parseLinePlaiting(W38);
    const rows = data.byRecipeCode.get("FV1351A")!;
    expect(rows.reduce((s, r) => s + r.actualPortions, 0)).toBe(4448 + 512);
    const thu = rows.find(r => r.day === "Thursday")!;
    expect(thu.dayNeedPortions).toBe(900);
  });
});

describe("parseLinePlaiting — header-basierte Spaltenerkennung", () => {
  it("erkennt die KW aus dem Tab-Kopf", () => {
    expect(parseLinePlaiting(W36).week).toBe("W36");
    expect(parseLinePlaiting(W35).week).toBe("W35");
    expect(parseLinePlaiting(W34).week).toBe("W34");
  });

  it("liest das W36-Layout korrekt (verschobene Spalten, neue Start/Stop/RunTime)", () => {
    const data = parseLinePlaiting(W36);
    const tue = data.rows.find((r) => r.day === "Tuesday" && r.recipeCode === "FV4034A");
    expect(tue).toBeDefined();
    expect(tue!.plannedPortions).toBe(5485);
    expect(tue!.actualPortions).toBe(5168);
    expect(tue!.deltaPortions).toBe(-317);
    expect(tue!.shortageReason).toBe("Potatoes and Chicken");
    expect(tue!.shortagePct).toBeCloseTo(5.78);

    const curry = data.rows.find((r) => r.recipeCode === "FV0478A");
    expect(curry!.plannedPortions).toBe(1433);
    expect(curry!.actualPortions).toBe(1056);
    expect(curry!.shortageReason).toContain("recipe was wrong");
  });

  it("erkennt die Montag-Zeilen nicht als Plating-Daten", () => {
    const data = parseLinePlaiting(W36);
    expect(data.rows.some((r) => r.day === "Monday")).toBe(false);
  });

  it("zieht '{Tag} needs' als dayNeedPortions (Do), auch außerhalb der Fr-Phase", () => {
    const data = parseLinePlaiting(W36);
    const thu = data.rows.find((r) => r.day === "Thursday" && r.recipeCode === "FV4034A");
    expect(thu!.dayNeedPortions).toBe(400);
    expect(thu!.minNeededPortions).toBeNull(); // nur die Fr-Phase setzt minNeededPortions
  });

  it("setzt Fr-'FRI needs' zusätzlich als minNeededPortions und liest Status-Text aus der %-Spalte", () => {
    const data = parseLinePlaiting(W36);
    const fri = data.rows.find((r) => r.day === "Friday" && r.recipeCode === "FV1942A");
    expect(fri!.dayNeedPortions).toBe(850);
    expect(fri!.minNeededPortions).toBe(850);
    expect(fri!.statusText).toBe("blocked WO235");
    expect(fri!.shortagePct).toBeNull();
  });

  it("behandelt '{Tag} needs' = 'done' (Sa) als null, nicht als Zahl", () => {
    const data = parseLinePlaiting(W36);
    const sat = data.rows.find((r) => r.day === "Saturday" && r.recipeCode === "FV4034A");
    expect(sat!.dayNeedPortions).toBeNull();
    expect(sat!.deltaPortions).toBe(222); // Überschuss, positiv
  });

  it("liest die Tages-Summenzeile (Code leer, Planned gefüllt)", () => {
    const data = parseLinePlaiting(W36);
    const tot = data.dayTotals.find((d) => d.day === "Tuesday");
    expect(tot).toBeDefined();
    expect(tot!.plannedPortions).toBe(26708);
    expect(tot!.actualPortions).toBe(15264);
  });

  it("W35-Layout: liest Shortage + Fr-Mindestbedarf aus der alten 'Backfills'-Spalte", () => {
    const data = parseLinePlaiting(W35);
    const tue = data.rows.find((r) => r.day === "Tuesday" && r.recipeCode === "FV0713A");
    expect(tue!.plannedPortions).toBe(1000);
    expect(tue!.deltaPortions).toBe(-200);
    expect(tue!.backfillConfirmed).toBe(true);

    const fri = data.rows.find((r) => r.day === "Friday" && r.recipeCode === "FV0713A");
    expect(fri!.minNeededPortions).toBe(260);
    expect(fri!.dayNeedPortions).toBe(260);
  });

  it("W34-Layout: 'Min Needs THU' wird als dayNeedPortions erkannt", () => {
    const data = parseLinePlaiting(W34);
    const thu = data.rows.find((r) => r.recipeCode === "FV0576A");
    expect(thu!.dayNeedPortions).toBe(1200);
    expect(thu!.deltaPortions).toBe(-1390);
    expect(thu!.shortageReason).toContain("Rosemary Carrot");
  });

  it("gviz-CSV: merged Kopfzeile + gestrippte Wiederhol-Header werden korrekt gemerged", () => {
    const data = parseLinePlaiting(W36_GVIZ);
    expect(data.week).toBe("W36");
    expect(data.rows.some((r) => r.day === "Monday")).toBe(false);

    // Dienstag-Zeilen: Spalten kommen aus der gemergten Kopfzeile, obwohl die
    // Dienstag-"Comms"-Zeile Planned/Actual/Delta nicht mehr beschriftet.
    const tue = data.rows.find((r) => r.recipeCode === "FV4034A");
    expect(tue).toBeDefined();
    expect(tue!.plannedPortions).toBe(5485);
    expect(tue!.actualPortions).toBe(5168);
    expect(tue!.deltaPortions).toBe(-317);
    expect(tue!.shortageReason).toBe("Potatoes and Chicken");

    const curry = data.rows.find((r) => r.recipeCode === "FV0478A");
    expect(curry!.plannedPortions).toBe(1433);
    expect(curry!.actualPortions).toBe(1056);

    const tot = data.dayTotals.find((d) => d.day === "Tuesday");
    expect(tot!.plannedPortions).toBe(26708);

    // Freitag: Spalte 19 ist jetzt "Comments" → Freitext landet in comment,
    // "{Tag} needs" (850) wird trotzdem erkannt.
    const fri = data.rows.find((r) => r.recipeCode === "FV1942A");
    expect(fri!.dayNeedPortions).toBe(850);
    expect(fri!.minNeededPortions).toBe(850);
    expect(fri!.comment).toContain("no carrots");
  });
});
