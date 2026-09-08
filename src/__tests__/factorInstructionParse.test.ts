import { describe, expect, it } from "vitest";
import { normalizeFactorSteps, parseFactorRecipePdfText } from "../features/ket-plan/factorInstructionParse";

// Ausschnitte aus echten "Recipes <Tag>.pdf" (pdftotext DEFAULT-Modus): der
// EN-Anweisungsblock und der DE-Block stehen jeweils als EIN Absatz.
const SAMPLE = `FV0601A - Mozzarella Burger & Roasted Potatoes [DE] · REC-013423-4-003 · 1917 portions · RUN 4

Roasted Garlic and Parsley Roasted Potato - SH

WO 34-84

Cooking: Oven Process: OVEN / BLAST CHILLER Batches: 4 × 83 kg Portion: 115 grams · scoop white

INGREDIENT

PER BATCH TOTAL

FA-DE Potatoes, Diced 10mm /Kartoffeln, gewürfelt, 10 mm

72.88 kg 291.52 kg

INSTRUCTIONS (EN) A. VEGGIE DEBOX 1. In Wannes, combine all ingredients (except potato) to form a paste. 2. Toss the paste with the potatoes. 3. Transfer to GN 1/1 65 mm pans (2.5 KG per sheet tray) B. OVEN 1. Roast per Oven Setting: Roasted Diced Potatoes 10mm Appearance - Golden-brown cubes with crispy skins 2. FSQA CCP1 Check 3. Transfer to pre-blast associates

ANLEITUNG (DE) A. VEGETARISCHE DEBOX 1. In Wannes alle Zutaten (außer Kartoffel) zu einer Paste vermengen. 2. Die Paste mit den Kartoffeln vermischen. 3. Auf GN 1/1 65 mm-Pfannen umfüllen (2,5 kg pro Blattschale) B. OFEN 1. Einstellung Braten pro Ofen: Geröstete gewürfelte Kartoffeln 2. FQA CCP1-Überprüfung 3. Transfer an die Mitarbeiter von Pre-Blast

FV0485A - Rosemary-tomato chicken - [DE] · REC-013537-4-007 · 3232 portions · RUN 12

Shredded Chicken - naturel

WO 38-56

Cooking: — Process: MARINADE / OVEN / HOT SHREDDER / BLAST CHILLER Batches: 1 × 576 kg

Portion: 110 grams · scoop beige

🧂 BRINE — Chicken Thighs - BRINED

INGREDIENT

FA-DE Chicken, Thighs, Boneless Skinless SEPARATE

BRINE — INSTRUCTIONS (EN) A. DEBOX 1. Dissolve salt in HOT water; transfer to Wanne 2. Add COLD water. Brine temp should be below 3 °C 3. Add Chicken thighs 4. Sit for a minimum 4 hours. Hold up to 6 hours. 5. Drain

BRINE — ANLEITUNG (DE) A. DEBOX 1. Salz in HEISSEM Wasser auflösen; in die Wanne geben 2. KALTES Wasser dazugeben. Soletemperatur unter 3 °C 3. Hähnchenschenkel hinzufügen 4. Mindestens 4 Stunden ruhen. Bis zu 6 Stunden. 5. Abtropfen lassen

MARINADE — Shredded Chicken - naturel

INGREDIENT

FA-DE Oil, Olive /Öl, Olivenöl

MARINADE — INSTRUCTIONS (EN) A. PROTEIN DEBOX 1. Toss chicken with olive oil until fully coated. 2. Marinate for 2 hours. B. OVEN 5. Roast per "Chicken thigh" Oven Setting: 6. FSQA CCP1 Check C. MIDDLE KITCHEN 1. SHRED on speed 4.5 2. Mix in reserved liquid: 150 kg shredded chicken 20 kg pan liquid

MARINADE — ANLEITUNG (DE) A. PROTEINDEBOX 1. Hähnchen mit Olivenöl vermischen, bis es bedeckt ist. 2. 2 Stunden marinieren. B. OFEN 5. Braten pro "Hähnchenschenkel" Ofeneinstellung: 6. FQA CCP1-Überprüfung C. MITTLERE KÜCHE 1. SHRED auf Geschwindigkeit 4,5 2. Reservierte Flüssigkeit einrühren: 150 kg zerkleinertes Hähnchen 20 kg Pfannenflüssigkeit
`;

describe("normalizeFactorSteps", () => {
  it("splits a run-on paragraph into stations + numbered steps", () => {
    const out = normalizeFactorSteps(
      'INSTRUCTIONS (EN) A. VEGGIE DEBOX 1. Remove packaging 2. Combine in Wanne B. OVEN 1. Roast per Oven Setting: Foo Appearance - golden 2. FSQA CCP1 Check',
    );
    expect(out.split("\n")).toEqual([
      "A. VEGGIE DEBOX",
      "1. Remove packaging",
      "2. Combine in Wanne",
      "B. OVEN",
      "1. Roast per Oven Setting: Foo",
      "Appearance - golden",
      "2. FSQA CCP1 Check",
    ]);
  });

  it("normalises 'A:' colon headers and missing spaces to 'A. '", () => {
    expect(normalizeFactorSteps("C: PROTEIN DEBOX 1. Weigh").split("\n")[0]).toBe("C. PROTEIN DEBOX");
    expect(normalizeFactorSteps("A.MIDDLE KITCHEN 1. Mix").split("\n")[0]).toBe("A. MIDDLE KITCHEN");
  });
});

describe("parseFactorRecipePdfText", () => {
  const entries = parseFactorRecipePdfText(SAMPLE, "sample.pdf");

  it("keys a plain WO by recipeCode::subRecipeName with clean EN/DE steps", () => {
    const e = entries.find((x) => x.woNumber === "34-84");
    expect(e).toBeTruthy();
    expect(e!.recipeCode).toBe("FV0601A");
    expect(e!.subRecipeName).toBe("Roasted Garlic and Parsley Roasted Potato - SH");
    expect(e!.componentName).toBeUndefined();
    expect(e!.english).toContain("A. VEGGIE DEBOX");
    expect(e!.english).toContain("B. OVEN");
    expect(e!.german).toContain("A. VEGETARISCHE DEBOX");
    expect(e!.english).not.toContain("INSTRUCTIONS (EN)");
  });

  it("splits the brine stage and the marinade stage into separate component entries", () => {
    const brine = entries.find((x) => x.componentName === "Chicken Thighs - BRINED");
    const marinade = entries.find((x) => x.woNumber === "38-56" && x.componentName === "Shredded Chicken - naturel");
    expect(brine).toBeTruthy();
    expect(brine!.english).toContain("Brine temp should be below 3 °C");
    expect(brine!.english).not.toContain("MARINADE");
    expect(marinade).toBeTruthy();
    expect(marinade!.english).toContain("C. MIDDLE KITCHEN");
    expect(marinade!.english).toContain("150 kg shredded chicken");
    expect(marinade!.english).not.toContain("Brine temp");
  });

  it("preserves concrete detail from the real sheet verbatim", () => {
    const e = entries.find((x) => x.woNumber === "34-84")!;
    expect(e.english).toContain("GN 1/1 65 mm pans (2.5 KG per sheet tray)");
    expect(e.english).toContain("Roasted Diced Potatoes 10mm");
  });
});
