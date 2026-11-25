// Web Serial link for the Creality Ender 3 S1 / Marlin laser.
// One in-flight command at a time; resolves on the line-anchored "ok".
//
// Safety properties:
// - A yanked cable or dead read loop fails the pending command immediately
//   and reports the link as down (no 30 s timeout cascade, no fake "Connected").
// - After a command timeout the link is marked desynced: late "ok" lines are
//   drained until input is quiet before the next command is sent, so a stale
//   ok can never resolve the wrong command.
// - The port picker is always shown; a previously granted port is never
//   opened silently (it might be a different device).
//
// The `serial` constructor option is a test seam: anything shaped like
// navigator.serial (requestPort → port with open/close/setSignals/readable/
// writable/disconnect events) can drive the class under plain Node.

export const BAUD = 115200;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class Marlin {
  constructor({ onLog = () => {}, onState = () => {}, serial, timing = {} } = {}) {
    this.onLog = onLog;
    this.onState = onState;
    this.serial =
      serial ?? (typeof navigator !== "undefined" ? navigator.serial ?? null : null);
    this.timing = { bannerMs: 3000, quietMs: 250, resyncMaxMs: 3000, ...timing };
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.readLoop = null;
    this.decoder = new TextDecoder("utf-8", { stream: true });
    this.encoder = new TextEncoder();
    this.buffer = "";
    this.pending = null;
    this.queue = Promise.resolve();
    this.bannerResolve = null;
    this.desynced = false;
    this.lastLineAt = 0;
    this._connected = false;
    this.onPortDisconnect = () => this.handleLinkLoss("device unplugged");
  }

  get connected() {
    return this._connected;
  }

  async connect() {
    if (this._connected) return;
    if (!this.serial) {
      throw new Error(
        "Web Serial is not available. Use Chromium or Firefox 151+ on desktop, over localhost or https.",
      );
    }

    // Always ask: auto-opening ports[0] could silently target another device.
    const port = await this.serial.requestPort();
    await port.open({ baudRate: BAUD });

    this.port = port;
    this._connected = true;
    this.buffer = "";
    this.decoder = new TextDecoder("utf-8", { stream: true });
    port.addEventListener("disconnect", this.onPortDisconnect);

    try {
      await port.setSignals({ dataTerminalReady: false, requestToSend: false });
    } catch {
      /* optional; some bridges do not support it */
    }

    // Opening the port resets the board. Wait for the "start" banner instead
    // of a fixed sleep; fall back to a timeout for firmware that stays quiet.
    const banner = this.waitForBanner();
    this.startReadLoop();
    this.onLog("[serial] board reset; waiting for banner");
    await banner;
    if (!this._connected) {
      throw new Error("Serial link lost while waiting for the board banner.");
    }
    this.buffer = "";

    await this.send("M5", 5000).catch(() => {});
    this.onState({ connected: true, homed: false });
  }

  waitForBanner() {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.bannerResolve = null;
        resolve();
      };
      const timer = setTimeout(done, this.timing.bannerMs);
      this.bannerResolve = done;
    });
  }

  startReadLoop() {
    if (!this.port?.readable) return;
    this.reader = this.port.readable.getReader();
    this.readLoop = (async () => {
      try {
        while (true) {
          const { value, done } = await this.reader.read();
          if (done) break;
          this.buffer += this.decoder.decode(value, { stream: true });
          this.flushLines();
        }
      } catch (err) {
        if (this._connected) this.handleLinkLoss(`read error: ${err?.message ?? err}`);
      } finally {
        try {
          this.reader?.releaseLock();
        } catch {
          /* already released */
        }
        this.reader = null;
        // A closed stream while we still believe we are connected is a link
        // loss too (reader.cancel() during disconnect() runs after the flag
        // is cleared, so it never lands here).
        if (this._connected) this.handleLinkLoss("read stream closed");
      }
    })();
  }

  flushLines() {
    let idx;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, "");
      this.buffer = this.buffer.slice(idx + 1);
      this.handleLine(line);
    }
  }

  handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    this.lastLineAt = Date.now();
    this.onLog(trimmed);

    if (/^start\b/i.test(trimmed)) this.bannerResolve?.();

    const pending = this.pending;
    if (!pending) return;
    pending.lines.push(trimmed);

    // Hard faults never finish with ok; abort immediately instead of waiting
    // for the full command timeout.
    if (
      /^!!/.test(trimmed) ||
      /printer halted/i.test(trimmed) ||
      /kill\(\)/i.test(trimmed)
    ) {
      this.pending = null;
      pending.resolve({ ok: false, error: true, response: pending.lines.join("\n") });
      return;
    }

    // Error/unknown lines are recorded, but Marlin may still finish the
    // command with ok. Example: G28 on a laser conversion emits
    // "Error:Failed to enable Bed Leveling" and then "ok"; the mesh error is
    // irrelevant when Z is fixed. ok is the authoritative completion marker.
    if (/^error/i.test(trimmed) || /unknown command/i.test(trimmed)) {
      pending.error = true;
      return;
    }

    if (/^ok\b/i.test(trimmed)) {
      this.pending = null;
      pending.resolve({
        ok: true,
        error: Boolean(pending.error),
        response: pending.lines.join("\n"),
      });
    }
  }

  /** Resolve the in-flight command as a failure without waiting for ok. */
  failPending(reason) {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    pending.resolve({
      ok: false,
      error: true,
      response: pending.lines.length
        ? `${pending.lines.join("\n")}\n(${reason})`
        : reason,
    });
  }

  handleLinkLoss(reason) {
    if (!this._connected) return;
    this._connected = false;
    this.desynced = false;
    this.onLog(`[serial] link lost: ${reason}`);
    this.bannerResolve?.();
    this.failPending(`link lost: ${reason}`);
    this.onState({ connected: false, homed: false });
    this.closeTransport().catch(() => {});
  }

  /**
   * After a timeout, the firmware may still emit the command's ok later.
   * Drain input until it has been quiet for a moment so that stale ok cannot
   * resolve the next command early.
   */
  async drainUntilQuiet() {
    this.onLog("[serial] resync: draining late responses after a timeout");
    this.pending = null;
    this.lastLineAt = Date.now();
    const deadline = Date.now() + this.timing.resyncMaxMs;
    while (this._connected && Date.now() < deadline) {
      await sleep(25);
      if (!this.buffer && Date.now() - this.lastLineAt >= this.timing.quietMs) break;
    }
    this.buffer = "";
    this.desynced = false;
  }

  send(line, timeoutMs = 30000) {
    const run = async () => {
      if (!this._connected || !this.port) {
        throw new Error("Not connected");
      }
      if (this.desynced) await this.drainUntilQuiet();
      if (!this._connected || !this.port) {
        throw new Error("Not connected");
      }
      if (!this.writer) {
        this.writer = this.port.writable.getWriter();
      }

      this.onLog(`> ${line}`);

      return new Promise((resolve) => {
        const pending = { lines: [], error: false, resolve };
        const timer = setTimeout(() => {
          if (this.pending === pending) this.pending = null;
          this.desynced = true;
          const response = pending.lines.length
            ? `${pending.lines.join("\n")}\n(timeout)`
            : "timeout";
          resolve({ ok: false, error: Boolean(pending.error), response });
        }, timeoutMs);

        const finish = (value) => {
          clearTimeout(timer);
          resolve(value);
        };
        pending.resolve = finish;
        this.pending = pending;

        this.writer.write(this.encoder.encode(line + "\n")).catch((err) => {
          if (this.pending === pending) this.pending = null;
          finish({ ok: false, error: true, response: String(err?.message ?? err) });
        });
      });
    };

    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  async laserOff() {
    if (!this._connected) return;
    try {
      await this.send("M5", 5000);
    } catch {
      /* best effort */
    }
    try {
      await this.send("M5 S0", 5000);
    } catch {
      /* best effort */
    }
  }

  async closeTransport() {
    const port = this.port;
    if (port) port.removeEventListener("disconnect", this.onPortDisconnect);

    try {
      await this.reader?.cancel();
    } catch {
      /* already closed */
    }
    try {
      this.reader?.releaseLock();
    } catch {
      /* already released */
    }
    this.reader = null;

    try {
      await this.writer?.close();
    } catch {
      /* already closed */
    }
    try {
      this.writer?.releaseLock();
    } catch {
      /* already released */
    }
    this.writer = null;

    try {
      await port?.close();
    } catch {
      /* already closed */
    }
    this.port = null;
  }

  async disconnect() {
    if (!this._connected) return;

    // M5 must go out before the port closes; firmware latches laser state.
    try {
      await this.laserOff();
    } catch {
      /* best effort */
    }

    this._connected = false;
    // Anything still in flight (e.g. a move that never answered) must not
    // hang its caller once the port is going away.
    this.failPending("port closed");
    this.onState({ connected: false });

    await this.closeTransport();
    this.onState({ connected: false, homed: false });
  }
}
