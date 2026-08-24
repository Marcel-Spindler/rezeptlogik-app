import { describe, expect, it } from "vitest";
import { parseCsvRows } from "../features/gsheet-monitor/gsheetPoller";

describe("parseCsvRows", () => {
  it("keeps a quoted field with an embedded newline as one cell in one row", () => {
    const csv = 'a,"line one\nline two",c\nd,e,f\n';
    const rows = parseCsvRows(csv);
    expect(rows).toEqual([
      ["a", "line one\nline two", "c"],
      ["d", "e", "f"],
    ]);
  });

  it("handles quoted commas and escaped quotes", () => {
    const csv = '"1,2","say ""hi""",3\n';
    const rows = parseCsvRows(csv);
    expect(rows).toEqual([["1,2", 'say "hi"', "3"]]);
  });

  it("handles CRLF line endings", () => {
    const csv = "a,b\r\nc,d\r\n";
    const rows = parseCsvRows(csv);
    expect(rows).toEqual([["a", "b"], ["c", "d"]]);
  });

  it("drops fully-empty rows but keeps a final unterminated line", () => {
    const csv = "a,b\n\nc,d";
    const rows = parseCsvRows(csv);
    expect(rows).toEqual([["a", "b"], ["c", "d"]]);
  });
});
