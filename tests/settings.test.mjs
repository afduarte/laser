// Settings schema tests: defaults, validation, and persistence round-trip.
// A fake localStorage keeps this under plain Node.
//   npm test

import assert from "node:assert/strict";
import { test } from "node:test";
import { nextTick, reactive } from "vue";

import { loadSettings, persistSettings } from "../src/lib/settings.js";

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  globalThis.localStorage = {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
  };
  return map;
}

test("defaults when storage is empty", () => {
  fakeStorage();
  const s = loadSettings();
  assert.equal(s.focusZ, "");
  assert.equal(s.dotPower, 50);
  assert.equal(s.dotMs, 300);
  assert.equal(s.step, 1);
  assert.equal(s.dryRun, true, "a fresh browser starts dry");
  assert.equal(s.overrideS, 500);
  assert.equal(s.overrideEnabled, false);
  assert.equal(s.dark, false);
  assert.equal(s.powerScale, "relative");
});

test("numbers are clamped and garbage falls back", () => {
  fakeStorage({
    "laser.dotPower": "5000",
    "laser.dotMs": "10",
    "laser.overrideS": "abc",
    "laser.focus_z": "12.5",
  });
  const s = loadSettings();
  assert.equal(s.dotPower, 1000, "clamped to S1000");
  assert.equal(s.dotMs, 50, "clamped to the 50 ms floor");
  assert.equal(s.overrideS, 500, "garbage falls back");
  assert.equal(s.focusZ, 12.5, "numeric Z target parsed");
});

test("power scale is a strict enum", () => {
  fakeStorage({ "laser.powerScale": "absolute" });
  assert.equal(loadSettings().powerScale, "absolute");
  fakeStorage({ "laser.powerScale": "bogus" });
  assert.equal(loadSettings().powerScale, "relative");
});

test("changes persist through the watchers", async () => {
  const map = fakeStorage();
  const state = reactive(loadSettings());
  persistSettings(state);

  state.dotPower = 123;
  state.dryRun = false;
  state.focusZ = 7.5;
  await nextTick();

  assert.equal(map.get("laser.dotPower"), "123");
  assert.equal(map.get("laser.dryRun"), "false");
  assert.equal(map.get("laser.focus_z"), "7.5");

  const reloaded = loadSettings();
  assert.equal(reloaded.dotPower, 123);
  assert.equal(reloaded.dryRun, false);
});
