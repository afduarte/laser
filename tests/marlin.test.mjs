// Marlin protocol tests against a fake Web Serial transport — plain Node,
// no browser, no hardware. The fake port uses real ReadableStream /
// WritableStream / EventTarget, so the class runs the same code paths it
// runs against navigator.serial.
//   npm test

import assert from "node:assert/strict";
import { test } from "node:test";

import { Marlin } from "../src/lib/marlin.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class FakePort extends EventTarget {
  constructor() {
    super();
    this.written = [];
    this.opened = false;
    this.closed = false;
    this.readable = new ReadableStream({
      start: (controller) => {
        this.controller = controller;
      },
    });
    this.writable = new WritableStream({
      write: (chunk) => {
        this.written.push(decoder.decode(chunk));
      },
    });
  }

  async open() {
    this.opened = true;
  }

  async setSignals() {}

  async close() {
    this.closed = true;
    try {
      this.controller.close();
    } catch {
      /* already closed */
    }
  }

  /** Firmware → host. */
  emit(text) {
    this.controller.enqueue(encoder.encode(text));
  }

  get lines() {
    return this.written.join("").split("\n").filter(Boolean);
  }
}

async function waitUntil(fn, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await sleep(5);
  }
}

function setup() {
  const port = new FakePort();
  const logs = [];
  const states = [];
  let pickerCalls = 0;
  const marlin = new Marlin({
    onLog: (line) => logs.push(line),
    onState: (patch) => states.push(patch),
    serial: {
      requestPort: async () => {
        pickerCalls++;
        return port;
      },
    },
    // Short timing so the suite stays fast; production defaults are longer.
    timing: { bannerMs: 200, quietMs: 40, resyncMaxMs: 500 },
  });
  return { port, logs, states, marlin, pickerCalls: () => pickerCalls };
}

async function connect(marlin, port) {
  const connecting = marlin.connect();
  await waitUntil(() => port.opened);
  port.emit("start\n");
  await waitUntil(() => port.lines.includes("M5"));
  port.emit("ok\n");
  await connecting;
}

// Answer the two laser-off commands so teardown does not sit through timeouts.
async function disconnectClean(marlin, port) {
  const disconnecting = marlin.disconnect();
  await waitUntil(() => port.lines.filter((l) => l === "M5").length >= 2);
  port.emit("ok\n");
  await waitUntil(() => port.lines.includes("M5 S0"));
  port.emit("ok\n");
  await disconnecting;
}

test("connect shows the picker, waits for the banner, sends M5", async () => {
  const { port, marlin, states, pickerCalls } = setup();
  await connect(marlin, port);

  assert.equal(pickerCalls(), 1, "port picker is always shown");
  assert.equal(marlin.connected, true);
  assert.equal(port.lines[0], "M5", "laser forced off after the reset");
  assert.ok(
    states.some((s) => s.connected === true && s.homed === false),
    "connected + not homed reported",
  );
  await disconnectClean(marlin, port);
});

test("commands are serialized: one in flight, next waits for ok", async () => {
  const { port, marlin } = setup();
  await connect(marlin, port);

  const a = marlin.send("G0 X1");
  const b = marlin.send("G0 X2");
  await waitUntil(() => port.lines.includes("G0 X1"));
  assert.ok(!port.lines.includes("G0 X2"), "second command held back");

  port.emit("ok\n");
  assert.equal((await a).ok, true);
  await waitUntil(() => port.lines.includes("G0 X2"));
  port.emit("ok\n");
  assert.equal((await b).ok, true);
  await disconnectClean(marlin, port);
});

test("error lines are recorded but ok still completes the command", async () => {
  const { port, marlin } = setup();
  await connect(marlin, port);

  const pending = marlin.send("G28", 5000);
  await waitUntil(() => port.lines.includes("G28"));
  port.emit("Error:Failed to enable Bed Leveling\nok\n");
  const result = await pending;
  assert.equal(result.ok, true, "ok is authoritative");
  assert.equal(result.error, true, "firmware error recorded");
  await disconnectClean(marlin, port);
});

test("hard faults abort immediately without ok", async () => {
  const { port, marlin } = setup();
  await connect(marlin, port);

  const pending = marlin.send("G0 X1", 60000);
  await waitUntil(() => port.lines.includes("G0 X1"));
  const started = Date.now();
  port.emit("!! Printer halted\n");
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.error, true);
  assert.ok(Date.now() - started < 1000, "no timeout wait");
  await disconnectClean(marlin, port);
});

test("after a timeout, a late ok cannot resolve the next command", async () => {
  const { port, marlin } = setup();
  await connect(marlin, port);

  const first = await marlin.send("G0 X1", 60);
  assert.equal(first.ok, false);
  assert.match(first.response, /timeout/);

  // The timed-out command's ok arrives late, after the timeout fired.
  port.emit("ok\n");

  let secondDone = false;
  const second = marlin.send("G0 X2", 2000).then((result) => {
    secondDone = true;
    return result;
  });
  await waitUntil(() => port.lines.includes("G0 X2"));
  await sleep(30);
  assert.equal(secondDone, false, "stale ok was drained, not consumed");

  port.emit("ok\n");
  const result = await second;
  assert.equal(result.ok, true);
  await disconnectClean(marlin, port);
});

test("unplugging fails the pending command immediately", async () => {
  const { port, marlin, states } = setup();
  await connect(marlin, port);

  const pending = marlin.send("G0 X1", 60000);
  await waitUntil(() => port.lines.includes("G0 X1"));
  const started = Date.now();
  port.dispatchEvent(new Event("disconnect"));

  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.response, /link lost/);
  assert.ok(Date.now() - started < 1000, "no 30 s timeout cascade");
  assert.equal(marlin.connected, false);
  assert.ok(states.some((s) => s.connected === false && s.homed === false));
});

test("a closed read stream is also a link loss", async () => {
  const { port, marlin } = setup();
  await connect(marlin, port);

  const pending = marlin.send("G0 X1", 60000);
  await waitUntil(() => port.lines.includes("G0 X1"));
  port.controller.close();

  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.response, /link lost/);
  assert.equal(marlin.connected, false);
});

test("queued commands after a link loss reject instead of hanging", async () => {
  const { port, marlin } = setup();
  await connect(marlin, port);

  const pending = marlin.send("G0 X1", 60000);
  await waitUntil(() => port.lines.includes("G0 X1"));
  port.dispatchEvent(new Event("disconnect"));
  await pending;

  await assert.rejects(() => marlin.send("G0 X2"), /Not connected/);
});

test("disconnect sends M5 twice, then closes the port", async () => {
  const { port, marlin } = setup();
  await connect(marlin, port);

  const disconnecting = marlin.disconnect();
  await waitUntil(() => port.lines.filter((l) => l === "M5").length >= 2);
  port.emit("ok\n");
  await waitUntil(() => port.lines.includes("M5 S0"));
  port.emit("ok\n");
  await disconnecting;

  assert.equal(marlin.connected, false);
  assert.equal(port.closed, true);
});
