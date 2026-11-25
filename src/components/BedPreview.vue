<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Button } from "@reclaim/ui";

import { BED, state } from "../lib/store.js";
import { clearPalette, palette, tokenColor } from "../lib/theme.js";

const emit = defineEmits(["open-file"]);

const wrap = ref(null);
const canvas = ref(null);
const staticLayer = document.createElement("canvas");

const PAD = 34;

// Burn intensity is quantized into this many alpha buckets so large raster
// jobs keep a bounded number of stroke calls and theme-cache entries.
const BURN_LEVELS = 32;
// Lowest-power lines stay faintly visible instead of vanishing.
const BURN_ALPHA_FLOOR = 0.2;

let observer = null;
let dpr = 1;
let width = 0;
let height = 0;
let staticDirty = true;

function geometry() {
  const scale = Math.min((width - PAD * 2) / BED, (height - PAD * 2) / BED);
  const side = BED * scale;
  return { scale, side, offX: (width - side) / 2, offY: (height - side) / 2 };
}

function toScreenX(g, x) {
  return g.offX + x * g.scale;
}

function toScreenY(g, y) {
  return g.offY + (BED - y) * g.scale;
}

function monoFont() {
  const stack = getComputedStyle(document.documentElement).getPropertyValue("--rc-font-mono").trim();
  return stack || "ui-monospace, monospace";
}

function buildStaticLayer() {
  if (!width || !height) return;
  const g = geometry();
  const ctx = staticLayer.getContext("2d");
  const colors = palette();

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  // Bed surface and 10 mm grid.
  ctx.fillStyle = colors.bed;
  ctx.fillRect(g.offX, g.offY, g.side, g.side);

  ctx.strokeStyle = colors.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let mm = 0; mm <= BED; mm += 10) {
    const x = toScreenX(g, mm);
    const y = toScreenY(g, mm);
    ctx.moveTo(x, g.offY);
    ctx.lineTo(x, g.offY + g.side);
    ctx.moveTo(g.offX, y);
    ctx.lineTo(g.offX + g.side, y);
  }
  ctx.stroke();

  // Axis labels every 50 mm.
  ctx.fillStyle = colors.muted;
  ctx.font = `10px ${monoFont()}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (let mm = 0; mm <= BED; mm += 50) {
    ctx.fillText(String(mm), toScreenX(g, mm), g.offY + g.side + 8);
  }
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let mm = 0; mm <= BED; mm += 50) {
    ctx.fillText(String(mm), g.offX - 8, toScreenY(g, mm));
  }

  ctx.strokeStyle = colors.grid;
  ctx.strokeRect(g.offX, g.offY, g.side, g.side);

  const job = state.job;
  if (!job) return;

  if (state.showTravel) {
    ctx.strokeStyle = tokenColor("--rc-ink-faint", 0.55);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const segment of job.segments) {
      if (segment.on) continue;
      ctx.moveTo(toScreenX(g, segment.x0), toScreenY(g, segment.y0));
      ctx.lineTo(toScreenX(g, segment.x1), toScreenY(g, segment.y1));
    }
    ctx.stroke();
  }

  // Burn paths: opacity tracks the S power of each segment. Relative scale
  // normalizes against the job's max S; absolute against the full S1000.
  const burn = job.segments.filter((segment) => segment.on);
  if (burn.length) {
    const maxPower =
      state.powerScale === "absolute"
        ? 1000
        : burn.reduce((max, segment) => Math.max(max, segment.power), 0);

    const buckets = new Map();
    for (const segment of burn) {
      const intensity = Math.min(1, segment.power / maxPower);
      const level = Math.round(intensity * (BURN_LEVELS - 1));
      let bucket = buckets.get(level);
      if (!bucket) buckets.set(level, (bucket = []));
      bucket.push(segment);
    }

    ctx.lineWidth = 1.25;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    // Faint first, strong on top at crossings.
    for (const level of [...buckets.keys()].sort((a, b) => a - b)) {
      const alpha = BURN_ALPHA_FLOOR + (level / (BURN_LEVELS - 1)) * (1 - BURN_ALPHA_FLOOR);
      ctx.strokeStyle = tokenColor("--rc-brand", alpha);
      ctx.beginPath();
      for (const segment of buckets.get(level)) {
        ctx.moveTo(toScreenX(g, segment.x0), toScreenY(g, segment.y0));
        ctx.lineTo(toScreenX(g, segment.x1), toScreenY(g, segment.y1));
      }
      ctx.stroke();
    }
  }

  if (job.bbox) {
    const { minX, minY, maxX, maxY } = job.bbox;
    const x = toScreenX(g, minX);
    const y = toScreenY(g, maxY);
    const w = (maxX - minX) * g.scale;
    const h = (maxY - minY) * g.scale;

    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = colors.bbox;
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, w, h);
    ctx.restore();

    ctx.fillStyle = colors.corners;
    for (const [cornerX, cornerY] of [
      [minX, minY],
      [maxX, minY],
      [maxX, maxY],
      [minX, maxY],
    ]) {
      ctx.beginPath();
      ctx.arc(toScreenX(g, cornerX), toScreenY(g, cornerY), 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawHead(ctx) {
  if (!state.pos) return;
  const g = geometry();
  const colors = palette();
  const x = toScreenX(g, state.pos.x);
  const y = toScreenY(g, state.pos.y);

  ctx.strokeStyle = colors.crosshair;
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  ctx.moveTo(x - 10, y);
  ctx.lineTo(x + 10, y);
  ctx.moveTo(x, y - 10);
  ctx.lineTo(x, y + 10);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, 3, 0, Math.PI * 2);
  ctx.stroke();

  const label = `X ${state.pos.x.toFixed(2)}  Y ${state.pos.y.toFixed(2)}`;
  ctx.font = `10px ${monoFont()}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";
  const textWidth = ctx.measureText(label).width;
  const labelX = Math.min(
    Math.max(x + 10, g.offX),
    g.offX + g.side - textWidth - 4,
  );
  const labelY = Math.max(y - 8, g.offY + 12);
  ctx.fillStyle = colors.ink;
  ctx.fillText(label, labelX, labelY);
}

function draw() {
  if (!canvas.value || !width || !height) return;
  if (staticDirty) {
    buildStaticLayer();
    staticDirty = false;
  }
  const ctx = canvas.value.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.value.width, canvas.value.height);
  ctx.drawImage(staticLayer, 0, 0);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawHead(ctx);
}

function resize() {
  if (!wrap.value) return;
  const rect = wrap.value.getBoundingClientRect();
  width = Math.max(1, Math.floor(rect.width));
  height = Math.max(1, Math.floor(rect.height));
  dpr = window.devicePixelRatio || 1;

  for (const target of [canvas.value, staticLayer]) {
    target.width = Math.round(width * dpr);
    target.height = Math.round(height * dpr);
  }
  canvas.value.style.width = `${width}px`;
  canvas.value.style.height = `${height}px`;

  staticDirty = true;
  draw();
}

// Coalesce repaints into one animation frame: during a job stream the
// crosshair can change several times per tick, but only the last one matters.
let frame = 0;

function scheduleDraw(rebuildStatic = false) {
  if (rebuildStatic) staticDirty = true;
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    draw();
  });
}

onMounted(() => {
  resize();
  observer = new ResizeObserver(() => resize());
  observer.observe(wrap.value);
});

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
});

watch(() => state.job, () => scheduleDraw(true));
watch(() => state.showTravel, () => scheduleDraw(true));
watch(() => state.powerScale, () => scheduleDraw(true));
watch(() => state.pos, () => scheduleDraw());
watch(
  () => state.dark,
  () => {
    clearPalette();
    scheduleDraw(true);
  },
  { flush: "post" },
);
</script>

<template>
  <div
    ref="wrap"
    class="relative min-h-[320px] w-full overflow-hidden rounded-rc border border-line bg-canvas"
  >
    <canvas ref="canvas" class="absolute inset-0 block"></canvas>

    <div
      v-if="!state.job"
      class="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center"
    >
      <svg
        width="28"
        height="28"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
        class="text-ink-faint"
      >
        <path
          d="M4 5.5h9l4 4V19a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1Z"
          stroke="currentColor"
          stroke-width="1.5"
        />
        <path d="M13 5.5V10h4.5" stroke="currentColor" stroke-width="1.5" />
      </svg>
      <p class="text-sm font-medium">No G-code loaded</p>
      <p class="max-w-sm text-xs text-ink-muted">
        Open a Lasertools .ngc file to preview it on the 220 × 220 mm bed.
      </p>
      <Button size="sm" @click="emit('open-file')">Open G-code</Button>
    </div>
  </div>
</template>