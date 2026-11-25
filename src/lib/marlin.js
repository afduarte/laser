// Web Serial link for the Creality Ender 3 S1 / Marlin laser.
// One in-flight command at a time; resolves on the line-anchored "ok".

export const BAUD = 115200;

export class Marlin {
  constructor({ onLog = () => {}, onState = () => {} } = {}) {
    this.onLog = onLog;
    this.onState = onState;
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.readLoop = null;
    this.decoder = new TextDecoder("utf-8", { stream: true });
    this.encoder = new TextEncoder();
    this.buffer = "";
    this.pending = null;
    this.queue = Promise.resolve();
    this._connected = false;
  }

  get connected() {
    return this._connected;
  }

  async connect() {
    if (this._connected) return;
    if (!navigator.serial) {
      throw new Error(
        "Web Serial is not available. Use Chromium or Firefox 151+ on desktop, over localhost or https.",
      );
    }

    const ports = await navigator.serial.getPorts();
    const port = ports[0] ?? (await navigator.serial.requestPort());
    await port.open({ baudRate: BAUD });

    this.port = port;
    this._connected = true;

    try {
      await port.setSignals({ dataTerminalReady: false, requestToSend: false });
    } catch {
      /* optional; some bridges do not support it */
    }

    this.startReadLoop();

    // Opening the port resets the board. Wait for the banner, then drain it.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    this.buffer = "";
    this.onLog("[serial] board reset; waiting for banner");

    await this.send("M5", 5000).catch(() => {});
    this.onState({ connected: true, homed: false });
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
        if (this._connected) this.onLog(`[serial] read error: ${err?.message ?? err}`);
      } finally {
        try {
          this.reader?.releaseLock();
        } catch {
          /* already released */
        }
        this.reader = null;
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
    this.onLog(trimmed);

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

  send(line, timeoutMs = 30000) {
    const run = async () => {
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

  async disconnect() {
    if (!this._connected) return;

    // M5 must go out before the port closes; firmware latches laser state.
    try {
      await this.laserOff();
    } catch {
      /* best effort */
    }

    this._connected = false;
    this.onState({ connected: false });

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
      await this.port?.close();
    } catch {
      /* already closed */
    }
    this.port = null;
    this.onState({ connected: false, homed: false });
  }
}
