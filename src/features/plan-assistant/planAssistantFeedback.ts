import { addDoc, collection, getFirebase, getFirebaseAuth, serverTimestamp } from "../../core/firebase";
import type { PlanAssistantSource } from "./planAssistantSources";

export type PlanAssistantFeedbackScore = "up" | "down";

export interface PlanAssistantFeedbackInput {
  question: string;
  answer: string;
  week: string;
  model: "flash" | "pro";
  score: PlanAssistantFeedbackScore;
  correction?: string;
  sources: PlanAssistantSource[];
}

export function buildPlanAssistantFeedback(input: PlanAssistantFeedbackInput) {
  return {
    question: input.question.trim(),
    answer: input.answer.trim(),
    week: input.week,
    model: input.model,
    score: input.score,
    correction: input.correction?.trim() ?? "",
    sources: input.sources.map((source) => ({ key: source.key, label: source.label, detail: source.detail })),
  };
}

export async function savePlanAssistantFeedback(input: PlanAssistantFeedbackInput): Promise<void> {
  if (!import.meta.env.VITE_FIREBASE_PROJECT_ID) return;
  const { db } = getFirebase();
  await addDoc(collection(db, "apps", "rezeptlogik", "planAssistantFeedback"), {
    ...buildPlanAssistantFeedback(input),
    actorUid: getFirebaseAuth().currentUser?.uid ?? "",
    submittedAt: serverTimestamp(),
  });
}