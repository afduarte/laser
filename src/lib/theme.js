// Canvas color resolution for Reclaim tokens. var(--rc-*) can compute to
// color(srgb ...) / oklab(...) forms; older canvas parsers reject those, so
// every token is resolved to plain rgba() at the read boundary, with a 1×1
// canvas readback as the fallback for forms the regex does not know.
// The probe MUST live on document.body (AGENTS.md rule 5); both the probe
// and the readback canvas are created lazily on first use.

let probe = null;
let readbackCtx = null;

const cache = new Map();

function ensureProbe() {
  if (probe) return;
  probe = document.createElement("div");
  probe.style.display = "none";
  document.body.appendChild(probe);
}

function parseCssColor(value) {
  const rgb = value.match(
    /^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i,
  );
  if (rgb) {
    return [
      Number(rgb[1]),
      Number(rgb[2]),
      Number(rgb[3]),
      rgb[4] === undefined ? 1 : Number(rgb[4]),
    ];
  }

  const srgb = value.match(
    /^color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)$/i,
  );
  if (srgb) {
    return [
      Number(srgb[1]) * 255,
      Number(srgb[2]) * 255,
      Number(srgb[3]) * 255,
      srgb[4] === undefined ? 1 : Number(srgb[4]),
    ];
  }

  return null;
}

function readFromCanvas(value) {
  if (!readbackCtx) {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    readbackCtx = canvas.getContext("2d", { willReadFrequently: true });
  }
  readbackCtx.clearRect(0, 0, 1, 1);
  readbackCtx.fillStyle = value;
  readbackCtx.fillRect(0, 0, 1, 1);
  const data = readbackCtx.getImageData(0, 0, 1, 1).data;
  return [data[0], data[1], data[2], data[3] / 255];
}

/**
 * Resolve a semantic token to an rgba() string canvas can parse.
 * @param {string} name e.g. "--rc-brand"
 * @param {number} alpha 0..1 multiplier
 */
export function tokenColor(name, alpha = 1) {
  const key = `${name}|${alpha}`;
  if (cache.has(key)) return cache.get(key);

  ensureProbe();
  probe.style.color = `var(${name})`;
  const computed = getComputedStyle(probe).color;

  let rgba = parseCssColor(computed);
  if (!rgba) rgba = readFromCanvas(computed);

  const [r, g, b, a] = rgba;
  const out = `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${
    Math.round(a * alpha * 1000) / 1000
  })`;
  cache.set(key, out);
  return out;
}

/** Re-resolve after a theme or dark-mode change. */
export function clearPalette() {
  cache.clear();
}

/** Canvas palette for the preview (solid tokens only). */
export function palette() {
  return {
    bed: tokenColor("--rc-surface"),
    grid: tokenColor("--rc-line"),
    bbox: tokenColor("--rc-warn"),
    corners: tokenColor("--rc-warn"),
    crosshair: tokenColor("--rc-success"),
    ink: tokenColor("--rc-ink"),
    muted: tokenColor("--rc-ink-muted"),
  };
}
