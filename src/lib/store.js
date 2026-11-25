// Reactive application state and every machine action.
// UI code calls these functions; hardware access lives in marlin.js.

import { computed, reactive, watch } from "vue";
import { toast } from "@reclaim/ui";

import { Marlin } from "./marlin.js";
import { overridePower, parseGcode } from "./gcode.js";

export const BED = 220;
export const XY_MAX = 220;
export const Z_MAX = 250;

const KEYS = {
  focusZ: "laser.focus_z",
  dotPower: "laser.dotPower",
  dotMs: "laser.dotMs",
  step: "laser.step",
  overrideS: "laser.overrideS",
  overrideEnabled: "laser.overrideEnabled",
  dryRun: "laser.dryRun",
  dark: "laser.dark",
  powerScale: "laser.powerScale",
};

const LASER_ON_RE = /^([MG]\d+)\s+S(\d+)/i;
const POS_RE = /X:(-?\d+\.?\d*)\s+Y:(-?\d+\.?\d*)\s+Z:(-?\d+\.?\d*)/;

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

function readNumber(key, fallback) {
  const raw = lsGet(key);
  if (raw === null || raw === "") return fallback;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : fallback;
}

function readBool(key, fallback) {
  const raw = lsGet(key);
  return raw === null ? fallback : raw === "true";
}

function readPowerScale() {
  return lsGet(KEYS.powerScale) === "absolute" ? "absolute" : "relative";
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function toNumber(value, fallback = Number.NaN) {
  const number = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(number) ? number : fallback;
}

export const state = reactive({
  // connection / machine
  connected: false,
  connecting: false,
  disconnecting: false,
  connectError: "",
  homed: false,
  busy: false,
  pos: null, // { x, y, z }
  serialSupported: typeof navigator !== "undefined" && Boolean(navigator.serial),

  // job
  job: null,
  jobName: "",
  running: false,
  stopRequested: false,
  progress: { sent: 0, total: 0 },
  currentLine: "",
  lastStatus: "", // "" | running | complete | stopped | error
  showTravel: false,

  // console
  log: [],

  // persisted settings
  focusZ: readNumber(KEYS.focusZ, ""),
  dotPower: clamp(readNumber(KEYS.dotPower, 50), 0, 1000),
  dotMs: clamp(readNumber(KEYS.dotMs, 300), 50, 2000),
  step: readNumber(KEYS.step, 1),
  dryRun: readBool(KEYS.dryRun, true),
  overrideS: clamp(readNumber(KEYS.overrideS, 500), 0, 1000),
  overrideEnabled: readBool(KEYS.overrideEnabled, false),
  dark: readBool(KEYS.dark, false),
  powerScale: readPowerScale(), // "relative" (job max S) | "absolute" (S1000)
});

/**
 * Effective send-time power override.
 * null = use each S value from the file; 0 = dry run; 1–1000 = override.
 * Dry run is a shortcut that forces 0 without changing the override value.
 */
export const effectivePower = computed(() => {
  if (state.dryRun) return 0;
  if (!state.overrideEnabled) return null;
  return clamp(Math.round(toNumber(state.overrideS, 0)), 0, 1000);
});

// Only warnings and errors get colour; everything else stays neutral.
function logTone(text) {
  if (text.startsWith("> ")) return "out";
  if (text.startsWith("[gcode]")) return "warn";
  if (
    /^(error\b|!!|printer halted|unknown command|kill\(\))/i.test(text) ||
    /unknown command/i.test(text)
  ) {
    return "error";
  }
  if (/^(echo:busy\b|resend:|busy\b)/i.test(text)) return "warn";

  if (/^\[[a-z]+\]/i.test(text)) {
    if (/\b(error|failed|abort|timeout|no ok|permission)\b/i.test(text)) return "error";
    if (/\b(warning|warn|stopped|stop requested|busy|resend)\b/i.test(text)) return "warn";
  }
  return "normal";
}

export function pushLog(line) {
  const text = String(line);
  state.log.push({ text, tone: logTone(text) });
  if (state.log.length > 2000) state.log.splice(0, state.log.length - 2000);
}

export const marlin = new Marlin({
  onLog: pushLog,
  onState: (patch) => {
    if (typeof patch.connected === "boolean") state.connected = patch.connected;
    if (typeof patch.homed === "boolean") state.homed = patch.homed;
  },
});

// --- modal confirmation -----------------------------------------------------
// The App renders one Dialog bound to this state; store actions await it.
export const confirmState = reactive({
  open: false,
  title: "",
  description: "",
  lines: [],
  confirmLabel: "Continue",
  cancelLabel: "Cancel",
  accent: null,
});

let confirmResolve = null;

export function confirmDialog(options = {}) {
  return new Promise((resolve) => {
    if (confirmResolve) confirmResolve(false);
    Object.assign(confirmState, {
      open: true,
      title: options.title ?? "Confirm",
      description: options.description ?? "",
      lines: options.lines ?? [],
      confirmLabel: options.confirmLabel ?? "Continue",
      cancelLabel: options.cancelLabel ?? "Cancel",
      accent: options.accent ?? null,
    });
    confirmResolve = resolve;
  });
}

export function resolveConfirm(value) {
  confirmState.open = false;
  const resolve = confirmResolve;
  confirmResolve = null;
  resolve?.(Boolean(value));
}

// --- positions --------------------------------------------------------------

export async function updatePosition() {
  if (!state.connected) return null;
  try {
    const result = await marlin.send("M114");
    const match = (result.response ?? "").match(POS_RE);
    if (!match) {
      pushLog("[ctl] could not parse the M114 response");
      return null;
    }
    state.pos = { x: Number(match[1]), y: Number(match[2]), z: Number(match[3]) };
    return state.pos;
  } catch (err) {
    pushLog(`[ctl] position error: ${err?.message ?? err}`);
    return null;
  }
}

function updateCrosshair(line) {
  const mx = line.match(/X(-?(?:\d+\.?\d*|\.\d+))/i);
  const my = line.match(/Y(-?(?:\d+\.?\d*|\.\d+))/i);
  if (!mx && !my) return;
  const previous = state.pos ?? { x: 0, y: 0, z: 0 };
  state.pos = {
    x: mx ? Number(mx[1]) : previous.x,
    y: my ? Number(my[1]) : previous.y,
    z: previous.z,
  };
}

// Any manual move / laser action must be homed first. Returns false even after
// homing so the interrupted action is never resumed automatically.
async function ensureHomed() {
  if (state.homed) return true;
  const shouldHome = await confirmDialog({
    title: "Not homed",
    description:
      "Opening the port resets the board, so the current position is unknown. Home before moving?",
    confirmLabel: "Home first",
  });
  if (shouldHome) await home();
  return false;
}

// --- connection -------------------------------------------------------------

export async function connect() {
  if (state.connected || state.connecting) return;
  state.connecting = true;
  state.connectError = "";
  try {
    await marlin.connect();
    state.connected = true;
    state.homed = false;
    state.pos = null;
    toast({
      title: "Connected",
      description: "Board was reset. Home before moving.",
      accent: "success",
      duration: 3000,
    });
  } catch (err) {
    const message = String(err?.message ?? err);
    let description = message;
    if (err?.name === "NotFoundError") description = "No serial port was selected.";
    if (/permission/i.test(message)) {
      description = `${message} Check that your user is in the uucp group and plug the printer in directly (no hub).`;
    }
    state.connectError = description;
    pushLog(`[serial] connect failed: ${message}`);
    toast({ title: "Could not connect", description, accent: "danger" });
  } finally {
    state.connecting = false;
  }
}

let idleResolve = null;

function whenIdle() {
  if (!state.running) return Promise.resolve();
  return new Promise((resolve) => {
    idleResolve = resolve;
  });
}

export async function disconnect() {
  if (!state.connected || state.disconnecting) return;
  state.disconnecting = true;
  try {
    if (state.running) {
      state.stopRequested = true;
      pushLog("[job] stop requested by disconnect");
    }
    await whenIdle();
    await marlin.disconnect();
  } catch (err) {
    pushLog(`[serial] disconnect error: ${err?.message ?? err}`);
  } finally {
    state.connected = false;
    state.homed = false;
    state.pos = null;
    state.running = false;
    state.stopRequested = false;
    state.busy = false;
    state.disconnecting = false;
  }
}

export async function laserOffNow() {
  if (!state.connected) return;
  if (state.running) {
    state.stopRequested = true;
    pushLog("[job] stop requested by laser off");
  }
  await marlin.laserOff();
  toast({ title: "Laser off", accent: "success", duration: 2000 });
}

// --- manual controls --------------------------------------------------------

export async function home() {
  if (!state.connected) return false;
  const wasBusy = state.busy;
  state.busy = true;
  try {
    pushLog("[ctl] homing");
    const result = await marlin.send("G28", 180000);
    if (!result.ok) {
      pushLog(`[ctl] homing failed: ${result.response}`);
      toast({
        title: "Homing failed",
        description: result.response || "No ok from G28.",
        accent: "danger",
      });
      return false;
    }
    state.homed = true;
    if (result.error) {
      pushLog("[ctl] homing completed with firmware warnings; the command returned ok");
    }
    await updatePosition();
    pushLog("[ctl] homed; Z0 is the bed surface");
    return true;
  } catch (err) {
    toast({ title: "Homing failed", description: String(err?.message ?? err), accent: "danger" });
    return false;
  } finally {
    state.busy = wasBusy;
  }
}

async function moveAxis(axis, delta) {
  if (!state.connected || state.running) return;
  const key = String(axis).toUpperCase();
  if (!["X", "Y", "Z"].includes(key)) return;
  const distance = toNumber(delta, 0);
  if (!Number.isFinite(distance) || distance === 0) return;

  const wasBusy = state.busy;
  state.busy = true;
  try {
    if (!(await ensureHomed())) return;
    if (!state.pos) await updatePosition();
    if (!state.pos) {
      toast({ title: "Position unknown", description: "Home the machine first.", accent: "warn" });
      return;
    }
    const lower = key.toLowerCase();
    const limit = key === "Z" ? Z_MAX : XY_MAX;
    const target = clamp(state.pos[lower] + distance, 0, limit);
    const result = await marlin.send(`G0 ${key}${target.toFixed(3)}`);
    if (!result.ok) {
      pushLog(`[ctl] ${key} move failed: ${result.response}`);
      toast({ title: `${key} move failed`, description: result.response || "No ok.", accent: "danger" });
      return;
    }
    await updatePosition();
  } catch (err) {
    toast({ title: "Move failed", description: String(err?.message ?? err), accent: "danger" });
  } finally {
    state.busy = wasBusy;
  }
}

export async function jog(axis, direction) {
  return moveAxis(axis, direction * toNumber(state.step, 1));
}

export async function nudgeZ(delta) {
  return moveAxis("Z", delta);
}

/** Move Z to the value entered in the Z panel's input. */
export async function moveToZ() {
  if (!state.connected || state.running) return;
  const target = toNumber(state.focusZ);
  if (!Number.isFinite(target)) {
    toast({
      title: "Z is not set",
      description: "Enter a Z value before using the 0 button.",
      accent: "warn",
    });
    return;
  }

  const wasBusy = state.busy;
  state.busy = true;
  try {
    if (!(await ensureHomed())) return;
    const clamped = clamp(target, 0, Z_MAX);
    const result = await marlin.send(`G0 Z${clamped.toFixed(3)}`);
    if (!result.ok) {
      pushLog(`[ctl] Z move failed: ${result.response}`);
      toast({ title: "Z move failed", description: result.response || "No ok.", accent: "danger" });
      return;
    }
    await updatePosition();
    pushLog(`[ctl] moved to Z ${clamped.toFixed(2)} mm`);
  } catch (err) {
    toast({ title: "Z move failed", description: String(err?.message ?? err), accent: "danger" });
  } finally {
    state.busy = wasBusy;
  }
}

// --- job --------------------------------------------------------------------

export async function loadFile(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = parseGcode(text);
    state.job = parsed;
    state.jobName = file.name;
    state.progress = { sent: 0, total: parsed.lines.length };
    state.currentLine = "";
    state.lastStatus = "";
    for (const warning of parsed.warnings) pushLog(`[gcode] ${warning}`);

    if (!parsed.lines.length) {
      toast({ title: "No G-code found", description: `${file.name} has no commands.`, accent: "warn" });
      return;
    }
    toast({
      title: "G-code loaded",
      description: `${file.name} — ${parsed.lines.length} lines${parsed.bbox ? "" : ", no firing moves"}`,
      accent: parsed.bbox ? "success" : "warn",
      duration: 2500,
    });
  } catch (err) {
    toast({ title: "Could not read the file", description: String(err?.message ?? err), accent: "danger" });
  }
}

export async function markCorners() {
  if (!state.connected || !state.job?.bbox || state.running) return;
  const job = state.job;
  const bbox = job.bbox;
  if (bbox.minX < 0 || bbox.minY < 0 || bbox.maxX > XY_MAX || bbox.maxY > XY_MAX) {
    toast({
      title: "Bounding box is outside the bed",
      description: "Move or rescale the job before marking corners.",
      accent: "danger",
    });
    return;
  }

  const wasBusy = state.busy;
  state.busy = true;
  try {
    if (!(await ensureHomed())) return;
    if (!state.connected || state.job !== job) return;

    const power = clamp(Math.round(toNumber(state.dotPower, 50)), 0, 1000);
    const ms = clamp(Math.round(toNumber(state.dotMs, 300)), 50, 2000);
    const corners = [
      [bbox.minX, bbox.minY],
      [bbox.maxX, bbox.minY],
      [bbox.maxX, bbox.maxY],
      [bbox.minX, bbox.maxY],
    ];

    if (power > 0) {
      const confirmed = await confirmDialog({
        title: "Fire alignment dots",
        description:
          "Four short pulses mark the job corners. Wear 450 nm glasses and put material under the beam.",
        lines: [
          `Power S${power} · ${ms} ms`,
          ...corners.map(([x, y], index) => `Corner ${index + 1}: X${x.toFixed(2)} Y${y.toFixed(2)}`),
        ],
        confirmLabel: "Fire dots",
        accent: "danger",
      });
      if (!confirmed || !state.connected || state.job !== job) return;
    }

    pushLog(
      power > 0
        ? `[dots] firing S${power} for ${ms} ms at each corner`
        : "[dots] dry corner visits (laser off)",
    );

    for (const [x, y] of corners) {
      const move = await marlin.send(`G0 X${x.toFixed(3)} Y${y.toFixed(3)}`);
      if (!move.ok) throw new Error(`move failed: ${move.response}`);

      if (power > 0) {
        const on = await marlin.send(`M3 S${power}`);
        if (!on.ok) throw new Error(`laser on failed: ${on.response}`);
        await marlin.send(`G4 P${ms}`);
        await marlin.send("M5");
        pushLog(`[dots] fired X${x.toFixed(2)} Y${y.toFixed(2)}`);
      } else {
        await marlin.send("G4 P500");
        pushLog(`[dots] dry visit X${x.toFixed(2)} Y${y.toFixed(2)}`);
      }
    }

    await updatePosition();
    pushLog(power > 0 ? "[dots] all corners fired" : "[dots] all corners visited");
  } catch (err) {
    pushLog(`[dots] error: ${err?.message ?? err}`);
    toast({ title: "Corner dots failed", description: String(err?.message ?? err), accent: "danger" });
  } finally {
    await marlin.laserOff();
    state.busy = wasBusy;
  }
}

export async function runJob() {
  if (!state.connected || !state.job?.lines?.length || state.running) return;
  if (!(await ensureHomed())) return;

  const job = state.job;
  if (!job?.lines?.length || !state.connected || state.running) return;
  const lines = job.lines;
  const firstFire = lines.find((line) => {
    const match = LASER_ON_RE.exec(line);
    return match && Number(match[2]) > 0;
  });
  const override = effectivePower.value;
  const isDryRun = override === 0;

  const confirmed = await confirmDialog({
    title: isDryRun
      ? "Run dry run"
      : override !== null
        ? `Fire the job at S${override}`
        : "Fire the job",
    description: isDryRun
      ? "The machine will move through the job with every nonzero S rewritten to S0. Clear the bed and keep watch."
      : override !== null
        ? `This job will fire the laser with every nonzero S rewritten to S${override}. Wear 450 nm glasses, align the material, and keep the area clear.`
        : "This job will fire the laser. Wear 450 nm glasses, align the material, and keep the area clear.",
    lines: isDryRun
      ? [`${lines.length} lines`, "Power override: S0"]
      : [
          firstFire ? `First firing line: ${firstFire}` : "No firing commands found",
          `${lines.length} lines`,
          ...(override !== null ? [`Power override: S${override}`] : []),
        ],
    confirmLabel: isDryRun ? "Start dry run" : "Fire",
    accent: isDryRun ? null : "danger",
  });
  if (!confirmed || state.running || !state.connected || state.job !== job) return;

  state.running = true;
  state.stopRequested = false;
  state.lastStatus = "running";
  state.progress = { sent: 0, total: lines.length };
  pushLog(
    `[job] ${
      isDryRun ? "dry run" : override !== null ? `S${override} override` : "run"
    } started (${lines.length} lines)`,
  );

  const relative = lines.some((line) => /^G91\b/i.test(line));
  if (relative) pushLog("[job] G91 relative moves found; position uses periodic M114");

  let sent = 0;
  try {
    for (let i = 0; i < lines.length; i++) {
      if (state.stopRequested) break;

      let line = lines[i];
      if (override !== null) line = overridePower(line, override);
      state.currentLine = line;

      const result = await marlin.send(line);
      if (state.stopRequested) break;

      if (!result.ok) {
        state.lastStatus = "error";
        pushLog(`[job] aborted at line ${i + 1}: ${result.response}`);
        toast({
          title: "Job aborted",
          description: `Line ${i + 1} did not complete.`,
          accent: "danger",
        });
        return;
      }
      if (result.error) {
        pushLog(`[job] warning line ${i + 1}: ${result.response}`);
      }

      sent++;
      if (!relative) updateCrosshair(line);
      if (relative && (sent % 50 === 0 || i === lines.length - 1)) await updatePosition();
      if (sent % 10 === 0 || i === lines.length - 1) {
        state.progress = { sent, total: lines.length };
      }
    }

    if (state.stopRequested) {
      state.lastStatus = "stopped";
      toast({
        title: "Job stopped",
        description: `${sent} of ${lines.length} lines sent.`,
        accent: "warn",
      });
    } else {
      state.lastStatus = "complete";
      state.progress = { sent: lines.length, total: lines.length };
      toast({
        title: "Job complete",
        description: `${lines.length} lines sent.`,
        accent: "success",
      });
    }
  } catch (err) {
    state.lastStatus = "error";
    pushLog(`[job] error: ${err?.message ?? err}`);
    toast({ title: "Job error", description: String(err?.message ?? err), accent: "danger" });
  } finally {
    await marlin.laserOff();
    state.running = false;
    state.stopRequested = false;
    await updatePosition();
    idleResolve?.();
    idleResolve = null;
    pushLog(`[job] finished: ${state.lastStatus}`);
  }
}

export function stopJob() {
  if (!state.running) return;
  state.stopRequested = true;
  pushLog("[job] stop requested; waiting for the in-flight line");
}

// --- derived state ----------------------------------------------------------

export const progressPct = computed(() => {
  const total = state.progress.total || 0;
  const sent = state.progress.sent || 0;
  return total > 0 ? Math.min(100, Math.round((sent / total) * 100)) : 0;
});

// --- theme ------------------------------------------------------------------

export function toggleDark() {
  state.dark = !state.dark;
  document.documentElement.classList.toggle("dark", state.dark);
  lsSet(KEYS.dark, String(state.dark));
}

// --- persistence ------------------------------------------------------------

watch(
  () => state.focusZ,
  (value) => lsSet(KEYS.focusZ, value === null || value === undefined ? "" : String(value)),
);
watch(() => state.dotPower, (value) => lsSet(KEYS.dotPower, String(value ?? "")));
watch(() => state.dotMs, (value) => lsSet(KEYS.dotMs, String(value ?? "")));
watch(() => state.step, (value) => lsSet(KEYS.step, String(value ?? "")));
watch(() => state.dryRun, (value) => lsSet(KEYS.dryRun, String(Boolean(value))));
watch(() => state.overrideS, (value) => lsSet(KEYS.overrideS, String(value ?? "")));
watch(() => state.overrideEnabled, (value) =>
  lsSet(KEYS.overrideEnabled, String(Boolean(value))),
);
watch(() => state.powerScale, (value) => lsSet(KEYS.powerScale, String(value)));