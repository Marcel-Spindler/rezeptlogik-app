import { describe, expect, it } from "vitest";
import { buildPlanAssistantFeedback } from "../features/plan-assistant/planAssistantFeedback";

describe("buildPlanAssistantFeedback", () => {
  it("speichert die fachliche Bewertung mit bereinigter Frage, Antwort und Datenbasis", () => {
    expect(buildPlanAssistantFeedback({
      question: "  Welche WO ist kritisch?  ",
      answer: "  WO 36-123 ist kritisch. ",
      week: "2026-W37",
      model: "flash",
      score: "down",
      correction: "  WO 36-125 fehlt. ",
      sources: [{ key: "reconciliation", label: "WO-Abgleich", detail: "aktueller Quellenabgleich" }],
    })).toEqual({
      question: "Welche WO ist kritisch?",
      answer: "WO 36-123 ist kritisch.",
      week: "2026-W37",
      model: "flash",
      score: "down",
      correction: "WO 36-125 fehlt.",
      sources: [{ key: "reconciliation", label: "WO-Abgleich", detail: "aktueller Quellenabgleich" }],
    });
  });
});