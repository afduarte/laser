// Persisted settings: one schema drives reading, validation, and the
// localStorage watchers. No module-level side effects — main.js reads the
// dark-mode flag from here before mount, the store loads the rest.

import { watch } from "vue";

function lsGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function lsSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode / quota — settings stay in memory only */
  }
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// Each entry: storage key, fallback, raw-string reader, value serializer.
const number = (key, fallback, min = -Infinity, max = Infinity) => ({
  key,
  fallback,
  read(raw) {
    if (raw === null || raw === "") return fallback;
    const value = Number.parseFloat(raw);
    return Number.isFinite(value) ? clamp(value, min, max) : fallback;
  },
  serialize: (value) => String(value ?? ""),
});

const bool = (key, fallback) => ({
  key,
  fallback,
  read: (raw) => (raw === null ? fallback : raw === "true"),
  serialize: (value) => String(Boolean(value)),
});

const SCHEMA = {
  // Z target is free text until the user commits a number; "" means unset.
  focusZ: {
    key: "laser.focus_z",
    fallback: "",
    read(raw) {
      if (raw === null || raw === "") return "";
      const value = Number.parseFloat(raw);
      return Number.isFinite(value) ? value : "";
    },
    serialize: (value) => (value === null || value === undefined ? "" : String(value)),
  },
  dotPower: number("laser.dotPower", 50, 0, 1000),
  dotMs: number("laser.dotMs", 300, 50, 2000),
  step: number("laser.step", 1),
  dryRun: bool("laser.dryRun", true),
  overrideS: number("laser.overrideS", 500, 0, 1000),
  overrideEnabled: bool("laser.overrideEnabled", false),
  dark: bool("laser.dark", false),
  powerScale: {
    key: "laser.powerScale",
    fallback: "relative",
    read: (raw) => (raw === "absolute" ? "absolute" : "relative"),
    serialize: (value) => String(value),
  },
};

/** Validated initial values for every persisted setting. */
export function loadSettings() {
  const values = {};
  for (const [name, entry] of Object.entries(SCHEMA)) {
    values[name] = entry.read(lsGet(entry.key));
  }
  return values;
}

/** Persist each setting whenever it changes on the reactive state object. */
export function persistSettings(state) {
  for (const [name, entry] of Object.entries(SCHEMA)) {
    watch(
      () => state[name],
      (value) => lsSet(entry.key, entry.serialize(value)),
    );
  }
}
