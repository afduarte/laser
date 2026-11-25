// Reactive application state and every machine action.
// UI code calls these functions; hardware access lives in marlin.js,
// persistence in settings.js, the confirmation dialog in confirm.js.
//
// Connection/manual state is one status value instead of a flag soup:
//   offline → connecting → ready ⇄ busy → running → disconnecting → offline
// `homed` and `stopRequested` are orthogonal flags. UI enablement is derived
// here once (canJog / canRun / canDots) so panels cannot drift apart.

import { computed, reactive } from "vue";
import { toast } from "@reclaim/ui";

import { Marlin } from "./marlin.js";
import { firingPower, overridePower, parseGcode, wordsOf } from "./gcode.js";
import { confirmDialog } from "./confirm.js";
import { loadSettings, persistSettings } from "./settings.js";

export const BED = 220;
export const XY_MAX = 220;
export const Z_MAX = 250;

const POS_RE = /X:(-?\d+\.?\d*)\s+Y:(-?\d+\.?\d*)\s+Z:(-?\d+\.?\d*)/;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function toNumber(value, fallback = Number.NaN) {
  const number = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(number) ? number : fallback;
}

export const state = reactive({
  // connection / machine
  status: "offline", // offline | connecting | ready | busy | running | disconnecting
  homed: false,
  connectError: "",
  pos: null, // { x, y, z }
  serialSupported: typeof navigator !== "undefined" && Boolean(navigator.serial),

  // job
  job: null,
  jobName: "",
  stopRequested: false,
  progress: { sent: 0, total: 0 },
  currentLine: "",
  lastStatus: "", // "" | running | complete | stopped | error
  showTravel: false,

  // console
  log: [],

  // persisted settings
  ...loadSettings(),
});

persistSettings(state);

// --- derived state ----------------------------------------------------------

export const connected = computed(
  () => state.status !== "offline" && state.status !== "connecting",
);
export const running = computed(() => state.status === "running");

/** Manual moves (jog, Z, home) are only allowed when idle and connected. */
export const canJog = computed(() => state.status === "ready");

export const bboxOutOfBed = computed(() => {
  const bbox = state.job?.bbox;
  if (!bbox) return false;
  return bbox.minX < 0 || bbox.minY < 0 || bbox.maxX > XY_MAX || bbox.maxY > XY_MAX;
});

export const canRun = computed(
  () => state.status === "ready" && Boolean(state.job?.lines?.length),
);
export const canDots = computed(
  () => state.status === "ready" && Boolean(state.job?.bbox) && !bboxOutOfBed.value,
);

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

export const progressPct = computed(() => {
  const total = state.progress.total || 0;
  const sent = state.progress.sent || 0;
  return total > 0 ? Math.min(100, Math.round((sent / total) * 100)) : 0;
});

// --- console ----------------------------------------------------------------

// Only warnings and errors get colour; everything else stays neutral.
function logTone(text) {
  if (text.startsWith("> ")) return "out";
  if (text.startsWith("[gcode]")) return "warn";
  if (/^(error\b|!!|printer halted|unknown command|kill\(\))/i.test(text)) return "error";
  if (/^(echo:busy\b|resend:|busy\b)/i.test(text)) return "warn";

  if (/^\[[a-z]+\]/i.test(text)) {
    if (/\b(error|failed|abort|timeout|no ok|permission|lost)\b/i.test(text)) return "error";
    if (/\b(warning|warn|stopped|stop requested|busy|resend)\b/i.test(text)) return "warn";
  }
  return "normal";
}

let logId = 0;

export function pushLog(line) {
  const text = String(line);
  state.log.push({ id: ++logId, text, tone: logTone(text) });
  if (state.log.length > 2000) state.log.splice(0, state.log.length - 2000);
}

// --- errors -----------------------------------------------------------------

function errorMessage(err) {
  return String(err?.message ?? err);
}

function reportError(title, err, logTag) {
  const message = errorMessage(err);
  if (logTag) pushLog(`[${logTag}] ${message}`);
  toast({ title, description: message, accent: "danger" });
}

// --- machine link -----------------------------------------------------------

export const marlin = new Marlin({
  onLog: pushLog,
  onState: (patch) => {
    if (patch.connected === false) {
      const unexpected =
        state.status === "ready" || state.status === "busy" || state.status === "running";
      state.status = "offline";
      state.homed = false;
      state.pos = null;
      state.stopRequested = false;
      if (unexpected) {
        toast({
          title: "Connection lost",
          description:
            "The serial link went down. Check the machine — the laser state cannot be confirmed from here.",
          accent: "danger",
        });
      }
    }
    if (typeof patch.homed === "boolean") state.homed = patch.homed;
  },
});

/**
 * Single-flight busy guard. Nests (ensureHomed → home inside a move) via a
 * depth counter; never restores over a status that changed meanwhile
 * (link loss, disconnect).
 */
let busyDepth = 0;

async function withBusy(fn) {
  busyDepth++;
  if (busyDepth === 1) state.status = "busy";
  try {
    return await fn();
  } finally {
    busyDepth--;
    if (busyDepth === 0 && state.status === "busy") state.status = "ready";
  }
}

const idleWaiters = new Set();

function whenIdle() {
  if (state.status !== "running") return Promise.resolve();
  return new Promise((resolve) => idleWaiters.add(resolve));
}

function resolveIdle() {
  for (const resolve of idleWaiters) resolve();
  idleWaiters.clear();
}

// --- positions --------------------------------------------------------------

export async function updatePosition() {
  if (!connected.value) return null;
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
    pushLog(`[ctl] position error: ${errorMessage(err)}`);
    return null;
  }
}

function updateCrosshair(line) {
  let x = null;
  let y = null;
  for (const [, letter, raw] of wordsOf(line)) {
    const upper = letter.toUpperCase();
    if (upper === "X") x = Number(raw);
    else if (upper === "Y") y = Number(raw);
  }
  if (x === null && y === null) return;
  const previous = state.pos ?? { x: 0, y: 0, z: 0 };
  state.pos = { x: x ?? previous.x, y: y ?? previous.y, z: previous.z };
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
  if (state.status !== "offline") return;
  state.status = "connecting";
  state.connectError = "";
  try {
    await marlin.connect();
    state.status = "ready";
    state.homed = false;
    state.pos = null;
    toast({
      title: "Connected",
      description: "Board was reset. Home before moving.",
      accent: "success",
      duration: 3000,
    });
  } catch (err) {
    state.status = "offline";
    const message = errorMessage(err);
    let description = message;
    if (err?.name === "NotFoundError") description = "No serial port was selected.";
    if (/permission/i.test(message)) {
      description = `${message} Check that your user is in the uucp group and plug the printer in directly (no hub).`;
    }
    state.connectError = description;
    pushLog(`[serial] connect failed: ${message}`);
    toast({ title: "Could not connect", description, accent: "danger" });
  }
}

export async function disconnect() {
  if (!connected.value || state.status === "disconnecting") return;
  try {
    if (state.status === "running") {
      state.stopRequested = true;
      pushLog("[job] stop requested by disconnect");
      await whenIdle();
    }
    state.status = "disconnecting";
    await marlin.disconnect();
  } catch (err) {
    pushLog(`[serial] disconnect error: ${errorMessage(err)}`);
  } finally {
    state.status = "offline";
    state.homed = false;
    state.pos = null;
    state.stopRequested = false;
  }
}

export async function laserOffNow() {
  if (!connected.value) return;
  if (state.status === "running") {
    state.stopRequested = true;
    pushLog("[job] stop requested by laser off");
  }
  await marlin.laserOff();
  toast({ title: "Laser off", accent: "success", duration: 2000 });
}

// --- manual controls --------------------------------------------------------

export async function home() {
  if (!connected.value) return false;
  return withBusy(async () => {
    pushLog("[ctl] homing");
    try {
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
      reportError("Homing failed", err);
      return false;
    }
  });
}

async function moveAxis(axis, delta) {
  if (!connected.value || state.status === "running") return;
  const key = String(axis).toUpperCase();
  if (!["X", "Y", "Z"].includes(key)) return;
  const distance = toNumber(delta, 0);
  if (!Number.isFinite(distance) || distance === 0) return;

  await withBusy(async () => {
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
      reportError("Move failed", err);
    }
  });
}

export async function jog(axis, direction) {
  return moveAxis(axis, direction * toNumber(state.step, 1));
}

export async function nudgeZ(delta) {
  return moveAxis("Z", delta);
}

/** Move Z to the value entered in the Z panel's input. */
export async function moveToZ() {
  if (!connected.value || state.status === "running") return;
  const target = toNumber(state.focusZ);
  if (!Number.isFinite(target)) {
    toast({
      title: "Z is not set",
      description: "Enter a Z value before using the 0 button.",
      accent: "warn",
    });
    return;
  }

  await withBusy(async () => {
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
      reportError("Z move failed", err);
    }
  });
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
    reportError("Could not read the file", err);
  }
}

export async function markCorners() {
  if (!canDots.value) return;
  const job = state.job;
  const bbox = job.bbox;

  await withBusy(async () => {
    try {
      if (!(await ensureHomed())) return;
      if (!connected.value || state.job !== job) return;

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
        if (!confirmed || !connected.value || state.job !== job) return;
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
      reportError("Corner dots failed", err, "dots");
    } finally {
      await marlin.laserOff();
    }
  });
}

export async function runJob() {
  if (!canRun.value) return;
  if (!(await ensureHomed())) return;

  const job = state.job;
  if (!canRun.value || state.job !== job) return;
  const lines = job.lines;
  const firstFire = lines.find((line) => (firingPower(line) ?? 0) > 0);
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
  if (!confirmed || !canRun.value || state.job !== job) return;

  state.status = "running";
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
    reportError("Job error", err, "job");
  } finally {
    await marlin.laserOff();
    if (state.status === "running") state.status = "ready";
    state.stopRequested = false;
    await updatePosition();
    resolveIdle();
    pushLog(`[job] finished: ${state.lastStatus}`);
  }
}

export function stopJob() {
  if (state.status !== "running") return;
  state.stopRequested = true;
  pushLog("[job] stop requested; waiting for the in-flight line");
}

// --- theme ------------------------------------------------------------------

export function toggleDark() {
  state.dark = !state.dark;
  document.documentElement.classList.toggle("dark", state.dark);
}
