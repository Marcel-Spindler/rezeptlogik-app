import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSeenWos,
  loadSeenWos,
  rememberWos,
  splitNewWos,
} from "../features/blast-chiller/blastChillerMemory";

// Test-Umgebung ist "node" → kein localStorage. Minimaler In-Memory-Ersatz.
class MemStorage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  clear() { this.m.clear(); }
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
}

beforeEach(() => {
  vi.stubGlobal("localStorage", new MemStorage());
});

describe("blastChillerMemory", () => {
  it("remembers WO numbers per week and merges on repeat", () => {
    rememberWos("W37", ["37-1", "37-2"]);
    expect([...loadSeenWos("W37")].sort()).toEqual(["37-1", "37-2"]);
    rememberWos("W37", ["37-2", "37-9"]);
    expect([...loadSeenWos("W37")].sort()).toEqual(["37-1", "37-2", "37-9"]);
    expect(loadSeenWos("W38").size).toBe(0);
  });

  it("clearSeenWos wipes only that week", () => {
    rememberWos("W37", ["37-1"]);
    rememberWos("W38", ["38-1"]);
    clearSeenWos("W37");
    expect(loadSeenWos("W37").size).toBe(0);
    expect([...loadSeenWos("W38")]).toEqual(["38-1"]);
  });

  it("splitNewWos separates known from fresh", () => {
    const seen = new Set(["37-1", "37-2"]);
    const items = [{ wo: "37-1" }, { wo: "37-3" }, { wo: "37-2" }, { wo: "37-4" }];
    const { fresh, known } = splitNewWos(items, seen);
    expect(fresh.map(i => i.wo)).toEqual(["37-3", "37-4"]);
    expect(known.map(i => i.wo)).toEqual(["37-1", "37-2"]);
  });

  it("empty week label is a no-op", () => {
    rememberWos("", ["x"]);
    expect(loadSeenWos("").size).toBe(0);
  });
});
