import test from "node:test";
import assert from "node:assert/strict";
import { reportFilename, rowsToCsv } from "../src/io/exportCsv.ts";

test("reportFilename builds {date}_{vehicle}_{event}_{model}.{suffix}", () => {
  const name = reportFilename("fsae-baseline", "straight-line-sweep", "model-v0p2", "csv");
  assert.match(name, /^\d{4}-\d{2}-\d{2}_fsae-baseline_straight-line-sweep_model-v0p2\.csv$/);
});

test("rowsToCsv: header and rows preserve first-row column order", () => {
  const rows = [
    { speed_mph: 60, deceleration_g: 1.2, pass: true },
    { speed_mph: 45, deceleration_g: 1.5, pass: false },
  ];
  const csv = rowsToCsv(rows);
  const lines = csv.split("\n");
  assert.equal(lines[0], "speed_mph,deceleration_g,pass");
  assert.equal(lines[1], "60,1.2,true");
  assert.equal(lines[2], "45,1.5,false");
  // trailing newline: split produces one empty string at the end
  assert.equal(lines[3], "");
  assert.equal(lines.length, 4);
});

test("rowsToCsv: empty array returns empty string", () => {
  assert.equal(rowsToCsv([]), "");
});

test("rowsToCsv: null/undefined values become empty fields", () => {
  const csv = rowsToCsv([{ a: null, b: undefined, c: 0 }]);
  assert.equal(csv, "a,b,c\n,,0\n");
});

test("rowsToCsv: missing keys on later rows render as empty cells", () => {
  const csv = rowsToCsv([{ a: 1, b: 2 }, { a: 3 }]);
  assert.equal(csv, "a,b\n1,2\n3,\n");
});

test("rowsToCsv quoting: comma-containing value is quoted", () => {
  const csv = rowsToCsv([{ note: "front, rear" }]);
  assert.equal(csv, 'note\n"front, rear"\n');
});

test("rowsToCsv quoting: double-quote-containing value is quoted and escaped", () => {
  const csv = rowsToCsv([{ note: 'the "best" pad' }]);
  assert.equal(csv, 'note\n"the ""best"" pad"\n');
});

test("rowsToCsv quoting: newline-containing value is quoted, embedded newline preserved", () => {
  const csv = rowsToCsv([{ note: "line one\nline two" }]);
  assert.equal(csv, 'note\n"line one\nline two"\n');
});

test("rowsToCsv quoting: value with comma, quote, and newline together", () => {
  const csv = rowsToCsv([{ note: 'a, "b"\nc' }]);
  assert.equal(csv, 'note\n"a, ""b""\nc"\n');
});

test("rowsToCsv quoting: plain values are not quoted", () => {
  const csv = rowsToCsv([{ a: "plain", b: 42 }]);
  assert.equal(csv, "a,b\nplain,42\n");
});

test("rowsToCsv quoting: header names containing commas are also quoted", () => {
  const csv = rowsToCsv([{ "front, rear ratio": 1.5 }]);
  assert.equal(csv, '"front, rear ratio"\n1.5\n');
});
