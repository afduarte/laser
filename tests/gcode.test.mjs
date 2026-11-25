// Pure parser tests — plain Node, no browser, no hardware.
//   npm test
// Fixtures are vendored in tests/fixtures so the suite runs anywhere.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { firingPower, overridePower, parseGcode } from "../src/lib/gcode.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "fixtures");

function approx(actual, expected, label) {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${label}: expected ${expected}, got ${actual}`,
  );
}

test("synthetic rectangle", () => {
  const text = `
    ; comment line
    G90 ; absolute
    G21 ; mm
    G0 X0 Y0
    M3 S500
    G1 X10 Y0
    G1 X10 Y10
    G1 X0 Y10
    G1 X0 Y0
    M5
  `;
  const r = parseGcode(text);

  assert.equal(r.lines.length, 9, "comments and blanks stripped");
  assert.equal(r.lines[0], "G90", "first cleaned line");
  assert.equal(r.lines.at(-1), "M5", "last cleaned line");

  assert.ok(r.bbox, "bbox present");
  approx(r.bbox.minX, 0, "bbox.minX");
  approx(r.bbox.minY, 0, "bbox.minY");
  approx(r.bbox.maxX, 10, "bbox.maxX");
  approx(r.bbox.maxY, 10, "bbox.maxY");

  assert.equal(r.stats.fireCount, 1, "one M3 S>0");
  assert.equal(r.stats.travelCount, 0, "the origin G0 does not move");
  assert.equal(r.segments.length, 4, "four firing moves");
  assert.equal(r.segments.filter((s) => s.on).length, 4, "four firing segments");
});

test("trailing-dot numbers", () => {
  const r = parseGcode("G90\nM3 S200\nG1 X91. Y117.29\nM5\n");
  assert.equal(r.segments.length, 1, "one segment");
  approx(r.segments[0].x1, 91, "X91. parsed as 91");
  approx(r.segments[0].y1, 117.29, "Y117.29 parsed");
  assert.equal(r.segments[0].on, true, "firing segment");
});

test("G91 relative accumulation", () => {
  const r = parseGcode("G91\nM3 S500\nG1 X10 Y10\nG1 X10 Y-5\nM5\n");
  assert.equal(r.segments.length, 2, "two relative segments");
  approx(r.segments[0].x1, 10, "first relative X");
  approx(r.segments[0].y1, 10, "first relative Y");
  approx(r.segments[1].x1, 20, "second relative X");
  approx(r.segments[1].y1, 5, "second relative Y");
});

test("bare S updates power while the laser is on", () => {
  const r = parseGcode("G90\nM3 S100\nG1 X10 Y0\nS500\nG1 X20 Y0\nM5\n");
  assert.equal(r.segments.length, 2, "two firing segments across a power change");
  assert.equal(r.segments[0].power, 100, "first segment uses M3 power");
  assert.equal(r.segments[1].power, 500, "bare S updates the active power");
  assert.equal(r.stats.fireCount, 1, "bare S is not an M3/M4 line");
});

test("M3 S0 excluded from the bbox", () => {
  const r = parseGcode("G90\nM3 S0\nG1 X10 Y10\nM5\n");
  assert.equal(r.bbox, null, "M3 S0 produces no firing bbox");
  assert.equal(r.segments[0].on, false, "M3 S0 segment is not firing");
  assert.equal(r.stats.fireCount, 0, "M3 S0 is not a fire command");
});

test("N line numbers and *checksums are tolerated", () => {
  const r = parseGcode("N10 G90\nN20 M3 S500\nN30 G1 X10 Y0*77\nN40 M5\n");
  assert.equal(r.segments.length, 1, "one segment");
  approx(r.segments[0].x1, 10, "N30 G1 parsed");
  assert.equal(r.segments[0].on, true, "firing segment");
  assert.equal(r.lines[2], "N30 G1 X10 Y0", "checksum stripped from the sent line");
});

test("modal bare-axis continuation repeats the last motion mode", () => {
  const r = parseGcode("G90\nM3 S500\nG1 X10 Y0\nX10 Y10\nX0 Y10\nM5\n");
  assert.equal(r.segments.length, 3, "two modal lines continue the G1");
  assert.equal(r.segments.filter((s) => s.on).length, 3, "all three fire");
  approx(r.bbox.maxX, 10, "bbox includes modal moves");
  approx(r.bbox.maxY, 10, "bbox includes modal moves");
});

test("modal continuation of G0 stays travel", () => {
  const r = parseGcode("G90\nG0 X5 Y5\nX10 Y10\n");
  assert.equal(r.segments.length, 2, "two travel segments");
  assert.equal(r.segments.filter((s) => s.on).length, 0, "no firing");
  assert.equal(r.bbox, null, "travel does not create a bbox");
});

test("bare axis words without a prior motion mode are ignored", () => {
  const r = parseGcode("G90\nX10 Y10\n");
  assert.equal(r.segments.length, 0, "no motion mode established yet");
});

test("zero-padded G codes normalize", () => {
  const r = parseGcode("G90\nG00 X5 Y5\nM3 S100\nG01 X10 Y5\nM5\n");
  assert.equal(r.segments.length, 2, "G00 travel + G01 fire");
  assert.equal(r.segments.filter((s) => s.on).length, 1, "one firing segment");
});

test("firingPower detects laser-on lines", () => {
  assert.equal(firingPower("M3 S500"), 500);
  assert.equal(firingPower("M4 S0"), 0);
  assert.equal(firingPower("M3"), 0, "M3 without S reports 0");
  assert.equal(firingPower("N5 M3 S250"), 250, "N word skipped");
  assert.equal(firingPower("G1 X10 Y10 S750"), null, "inline S is not a laser-on command");
  assert.equal(firingPower("M5"), null);
});

test("send-time S override", () => {
  assert.equal(overridePower("M3 S500", 300), "M3 S300", "M3 rewritten");
  assert.equal(overridePower("M4 S1000", 0), "M4 S0", "override zero makes a dry move");
  assert.equal(overridePower("M3 S0", 300), "M3 S0", "an existing S0 stays S0");
  assert.equal(overridePower("M5 S0", 0), "M5 S0", "M5 S0 unchanged");
  assert.equal(overridePower("G1 X10 Y10 S750", 300), "G1 X10 Y10 S300", "inline S rewritten");
  assert.equal(overridePower("S500", 300), "S300", "bare S rewritten");
  assert.equal(overridePower("M3S500", 300), "M3S300", "S without whitespace rewritten");
  assert.equal(overridePower("G1 X10 Y10", 300), "G1 X10 Y10", "unsigned move unchanged");
  assert.equal(overridePower("M3 S500", 2000), "M3 S1000", "power clamped to 1000");
});

for (const name of ["output.ngc", "test_grid.ngc", "test_paths.ngc"]) {
  test(`real Lasertools file: ${name}`, () => {
    const text = readFileSync(path.join(fixtures, name), "utf8");
    const r = parseGcode(text);

    assert.ok(r.lines.length > 0, `${name}: has lines`);
    assert.ok(r.bbox, `${name}: has a firing bbox`);
    assert.ok(r.bbox.minX >= 0 && r.bbox.minY >= 0, `${name}: bbox min >= 0`);
    assert.ok(r.bbox.maxX <= 220 && r.bbox.maxY <= 220, `${name}: bbox max <= 220`);
    assert.ok(r.stats.fireCount > 0, `${name}: has fire commands`);
  });
}
