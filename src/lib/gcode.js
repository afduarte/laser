// Pure G-code parser for the Lasertools / Marlin laser output.
// No DOM, no hardware — safe to unit-test under plain Node.

const WORD_RE = /([A-Za-z])\s*(-?(?:\d+\.?\d*|\.\d+))/g;

/**
 * Parse a .ngc/.gcode text blob.
 *
 * @param {string} text
 * @returns {{
 *   lines: string[],
 *   segments: Array<{x0:number,y0:number,x1:number,y1:number,on:boolean,power:number}>,
 *   bbox: {minX:number,minY:number,maxX:number,maxY:number} | null,
 *   stats: {lineCount:number, fireCount:number, travelCount:number},
 *   warnings: string[]
 * }}
 */
export function parseGcode(text) {
  const lines = [];
  const segments = [];
  const warnings = [];
  let lineCount = 0;
  let fireCount = 0;
  let travelCount = 0;

  let x = 0;
  let y = 0;
  let z = 0;
  let absolute = true;
  let laserOn = false;
  let power = 0;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.split(";")[0].trim();
    if (!line) continue;

    lines.push(line);
    lineCount++;

    const words = [...line.matchAll(WORD_RE)];
    if (words.length === 0) continue;

    const cmd = words[0][0].toUpperCase();
    const params = {};
    for (let i = 1; i < words.length; i++) {
      const letter = words[i][1].toUpperCase();
      params[letter] = parseFloat(words[i][2]);
    }

    const isTravel = cmd === "G0" || cmd === "G00";
    const isMove = isTravel || cmd === "G1" || cmd === "G01" || cmd === "G2" || cmd === "G3";

    if (cmd === "G90") {
      absolute = true;
      continue;
    }
    if (cmd === "G91") {
      absolute = false;
      continue;
    }
    if (cmd === "G20") {
      warnings.push("G20 (inches) is not supported; coordinates are treated as millimetres.");
      continue;
    }
    if (cmd === "G21") {
      continue;
    }
    if (cmd === "G2" || cmd === "G3") {
      warnings.push(`${cmd} arc approximated as a straight move.`);
      // fall through to the move handling below
    }

    if (cmd === "M3" || cmd === "M4") {
      laserOn = true;
      power = Number.isFinite(params.S) ? params.S : 0;
      if (power > 0) fireCount++;
      continue;
    }
    if (cmd === "M5") {
      laserOn = false;
      power = 0;
      continue;
    }

    // A bare S word updates the power while the laser is on.
    // The first word is the command itself, so its numeric value is words[0][2].
    if (cmd[0] === "S") {
      const value = Number.parseFloat(words[0][2]);
      if (laserOn && Number.isFinite(value)) power = value;
      continue;
    }

    if (isMove) {
      const x0 = x;
      const y0 = y;
      let x1 = x;
      let y1 = y;

      if (Number.isFinite(params.X)) x1 = absolute ? params.X : x + params.X;
      if (Number.isFinite(params.Y)) y1 = absolute ? params.Y : y + params.Y;
      if (Number.isFinite(params.Z)) z = absolute ? params.Z : z + params.Z;

      // A move line may carry its own S value (not used by Lasertools, but
      // Marlin accepts it). Keep the power in sync while the laser is on.
      if (laserOn && Number.isFinite(params.S)) power = params.S;

      if (x1 !== x0 || y1 !== y0) {
        const on = laserOn && power > 0 && !isTravel;
        segments.push({ x0, y0, x1, y1, on, power });
        if (on) {
          if (x0 < minX) minX = x0;
          if (x1 < minX) minX = x1;
          if (x0 > maxX) maxX = x0;
          if (x1 > maxX) maxX = x1;
          if (y0 < minY) minY = y0;
          if (y1 < minY) minY = y1;
          if (y0 > maxY) maxY = y0;
          if (y1 > maxY) maxY = y1;
        } else {
          travelCount++;
        }
      }

      x = x1;
      y = y1;
      continue;
    }

    // Everything else (G28, G4, M114, M84, M2, ...) is irrelevant to the preview.
  }

  const bbox =
    minX === Infinity
      ? null
      : { minX, minY, maxX, maxY };

  return {
    lines,
    segments,
    bbox,
    stats: { lineCount, fireCount, travelCount },
    warnings,
  };
}

/**
 * Send-time power override for one cleaned G-code line.
 * Every nonzero S word is rewritten; an existing S0 is left untouched.
 *
 * @param {string} line
 * @param {number} power 0–1000
 * @returns {string}
 */
export function overridePower(line, power) {
  const numeric = Number(power);
  const value = Number.isFinite(numeric)
    ? Math.min(1000, Math.max(0, Math.round(numeric)))
    : 0;

  return String(line ?? "").replace(
    /([Ss])(\d+(?:\.\d+)?)\b/g,
    (match, _letter, raw) => (Number(raw) > 0 ? `S${value}` : match),
  );
}
