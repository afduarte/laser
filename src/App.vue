<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Dialog,
  Input,
  Progress,
  Select,
  Separator,
  Switch,
  Toaster,
} from "@reclaim/ui";

import BedPreview from "./components/BedPreview.vue";
import LogPane from "./components/LogPane.vue";
import {
  XY_MAX,
  Z_MAX,
  confirmState,
  connect,
  disconnect,
  effectivePower,
  home,
  jog,
  laserOffNow,
  loadFile,
  markCorners,
  marlin,
  moveToZ,
  nudgeZ,
  progressPct,
  resolveConfirm,
  runJob,
  state,
  stopJob,
  toggleDark,
} from "./lib/store.js";

const fileInput = ref(null);

const stepOptions = [
  { value: "0.1", label: "0.1 mm" },
  { value: "1", label: "1 mm" },
  { value: "10", label: "10 mm" },
];

const powerScaleOptions = [
  { value: "relative", label: "Relative (job max)" },
  { value: "absolute", label: "Absolute (S1000)" },
];

const zOffsets = [-100, -10, -1, 0, 1, 10, 100];

function zButtonText(offset) {
  return offset > 0 ? `+${offset}` : String(offset);
}

function zButtonLabel(offset) {
  if (offset === 0) return "Move Z to the entered value";
  return `Move Z ${offset > 0 ? "up" : "down"} ${Math.abs(offset)} mm`;
}

const stepModel = computed({
  get: () => String(state.step),
  set: (value) => {
    state.step = Number(value);
  },
});

const manualDisabled = computed(
  () =>
    !state.connected ||
    state.connecting ||
    state.running ||
    state.busy ||
    state.disconnecting,
);

const runDisabled = computed(
  () =>
    !state.connected ||
    state.connecting ||
    !state.job?.lines?.length ||
    state.busy ||
    state.disconnecting,
);

const bboxOutOfBed = computed(() => {
  const bbox = state.job?.bbox;
  if (!bbox) return false;
  return bbox.minX < 0 || bbox.minY < 0 || bbox.maxX > XY_MAX || bbox.maxY > XY_MAX;
});

const dotsDisabled = computed(
  () =>
    !state.connected ||
    state.connecting ||
    !state.job?.bbox ||
    bboxOutOfBed.value ||
    state.running ||
    state.busy ||
    state.disconnecting,
);

const dotPowerNum = computed(() => {
  const value = Number(state.dotPower);
  return Number.isFinite(value) ? value : 0;
});

const positionLabel = computed(() => {
  if (!state.connected) return "offline";
  if (!state.pos) return "position unknown";
  return `X: ${state.pos.x.toFixed(2)}  Y: ${state.pos.y.toFixed(2)}  Z: ${state.pos.z.toFixed(2)}`;
});

const currentZLabel = computed(() => {
  if (!state.connected) return "offline";
  if (!state.pos) return "unknown";
  return `${state.pos.z.toFixed(2)} mm`;
});

const effectivePowerLabel = computed(() => {
  if (state.dryRun) return "S0 (dry run)";
  if (!state.overrideEnabled) return "From job";
  return `S${effectivePower.value} override`;
});

const jobBbox = computed(() => {
  const bbox = state.job?.bbox;
  if (!bbox) return "";
  const width = (bbox.maxX - bbox.minX).toFixed(1);
  const height = (bbox.maxY - bbox.minY).toFixed(1);
  return `${width} × ${height} mm @ ${bbox.minX.toFixed(1)}, ${bbox.minY.toFixed(1)}`;
});

const connectionBadge = computed(() => {
  if (state.connecting) return { label: "Connecting", accent: "warn" };
  if (state.disconnecting) return { label: "Disconnecting", accent: "warn" };
  if (state.connected) return { label: "Connected", accent: "success" };
  return { label: "Disconnected", accent: null };
});

const statusBadge = computed(() => {
  if (state.running) return { label: "Running", accent: "brand" };
  if (state.lastStatus === "complete") return { label: "Complete", accent: "success" };
  if (state.lastStatus === "stopped") return { label: "Stopped", accent: "warn" };
  if (state.lastStatus === "error") return { label: "Error", accent: "danger" };
  return null;
});

function openFile() {
  fileInput.value?.click();
}

async function onFileChange(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (file) await loadFile(file);
}

function onDialogOpen(open) {
  if (!open) resolveConfirm(false);
}

function onPageHide() {
  // Best effort only: unload cannot await. Documented as "stop before closing".
  marlin.laserOff();
}

onMounted(() => {
  window.addEventListener("pagehide", onPageHide);
});

onBeforeUnmount(() => {
  window.removeEventListener("pagehide", onPageHide);
});
</script>

<template>
  <div class="flex min-h-dvh flex-col bg-canvas text-ink">
    <header class="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-surface px-5 py-2.5">
      <div class="flex items-baseline gap-3">
        <h1 class="text-xl">Laser control</h1>
        <span class="text-xs text-ink-muted">Ender 3 S1 · 5 W</span>
      </div>

      <div class="flex flex-wrap items-center gap-1.5">
        <Badge :accent="connectionBadge.accent" variant="outline">
          {{ connectionBadge.label }}
        </Badge>
        <Badge v-if="state.connected && !state.homed" accent="warn">Not homed</Badge>
        <Badge v-if="state.running" accent="brand">Running</Badge>
      </div>

      <div class="ml-auto flex flex-wrap items-center gap-2">
        <Button
          v-if="state.connected"
          variant="outline"
          accent="danger"
          size="sm"
          @click="laserOffNow"
        >Laser off</Button>

        <Button
          v-if="state.connected"
          variant="outline"
          size="sm"
          :loading="state.disconnecting"
          @click="disconnect"
        >Disconnect</Button>
        <Button
          v-else
          size="sm"
          :loading="state.connecting"
          @click="connect"
        >Connect</Button>

        <Button
          variant="outline"
          size="sm"
          :disabled="state.running"
          @click="openFile"
        >Open G-code</Button>

        <Button variant="ghost" size="sm" @click="toggleDark">
          {{ state.dark ? "Light" : "Dark" }}
        </Button>
      </div>
    </header>

    <div class="flex min-h-0 flex-1 flex-col">
      <div v-if="!state.serialSupported" class="px-5 pt-4">
        <Alert accent="danger" title="Web Serial is unavailable">
          Use Chromium or Firefox 151+ on desktop, over localhost or https. File preview still
          works without a printer.
        </Alert>
      </div>

      <div v-else-if="state.connectError" class="px-5 pt-4">
        <Alert accent="danger" title="Could not open the serial port">
          {{ state.connectError }}
        </Alert>
      </div>

      <div class="flex min-h-0 flex-1 flex-col gap-6 p-5 xl:flex-row">
        <main class="flex min-h-[420px] min-w-0 flex-1 flex-col gap-3">
          <div class="flex flex-wrap items-end justify-between gap-3">
            <div class="flex flex-col gap-0.5">
              <template v-if="state.job">
                <h2 class="text-sm font-medium">{{ state.jobName || "Untitled job" }}</h2>
                <p class="font-mono text-xs text-ink-muted">
                  {{ state.job.stats.lineCount }} lines ·
                  {{ state.job.stats.fireCount }} fire ·
                  {{ state.job.stats.travelCount }} travel
                </p>
                <p v-if="state.job.bbox" class="font-mono text-xs text-ink-muted">
                  bbox {{ jobBbox }}
                </p>
                <p v-else class="text-xs text-warn">No firing geometry — corner dots are unavailable.</p>
              </template>
              <template v-else>
                <h2 class="text-sm font-medium">Preview</h2>
                <p class="text-xs text-ink-muted">Front-left origin, 220 × 220 mm bed.</p>
              </template>
            </div>

            <Checkbox v-model="state.showTravel" label="Show travel" />
          </div>

          <BedPreview class="min-h-0 flex-1" @open-file="openFile" />
        </main>

        <aside class="flex w-full shrink-0 flex-col gap-5 xl:w-[380px]">
          <section class="flex flex-col gap-3">
            <div class="flex items-baseline justify-between gap-3">
              <h2 class="text-sm font-medium">Jog</h2>
              <span class="font-mono text-xs text-ink-muted">{{ positionLabel }}</span>
            </div>

            <div class="flex items-end gap-2">
              <div class="w-28">
                <Select v-model="stepModel" :options="stepOptions" label="Step" size="sm" />
              </div>
              <Button variant="outline" size="sm" :disabled="manualDisabled" @click="home">
                Home
              </Button>
            </div>

            <div class="flex items-center justify-center gap-6">
              <div class="grid grid-cols-3 gap-1">
                <span></span>
                <Button
                  variant="outline"
                  icon
                  aria-label="Jog Y positive"
                  :disabled="manualDisabled"
                  @click="jog('Y', 1)"
                >↑</Button>
                <span></span>

                <Button
                  variant="outline"
                  icon
                  aria-label="Jog X negative"
                  :disabled="manualDisabled"
                  @click="jog('X', -1)"
                >←</Button>
                <span class="self-center text-center font-mono text-xs uppercase tracking-widest text-ink-faint">XY</span>
                <Button
                  variant="outline"
                  icon
                  aria-label="Jog X positive"
                  :disabled="manualDisabled"
                  @click="jog('X', 1)"
                >→</Button>

                <span></span>
                <Button
                  variant="outline"
                  icon
                  aria-label="Jog Y negative"
                  :disabled="manualDisabled"
                  @click="jog('Y', -1)"
                >↓</Button>
                <span></span>
              </div>
            </div>
          </section>

          <Separator />

          <section class="flex flex-col gap-3">
            <h2 class="text-sm font-medium">Z</h2>

            <div class="flex items-start gap-3">
              <div class="flex flex-1 flex-col gap-2">
                <Input
                  v-model="state.focusZ"
                  type="number"
                  min="0"
                  :max="Z_MAX"
                  step="0.1"
                  mono
                  label="Z (mm)"
                />

                <div class="flex items-baseline justify-between text-xs">
                  <span class="text-ink-muted">Current Z</span>
                  <span class="font-mono text-ink-muted">{{ currentZLabel }}</span>
                </div>

                <p class="text-xs text-ink-muted">0 moves to the entered Z value.</p>
              </div>

              <div class="flex w-28 shrink-0 flex-col gap-1">
                <Button
                  v-for="offset in zOffsets"
                  :key="offset"
                  variant="outline"
                  size="sm"
                  :disabled="manualDisabled"
                  :aria-label="zButtonLabel(offset)"
                  :title="zButtonLabel(offset)"
                  @click="offset === 0 ? moveToZ() : nudgeZ(offset)"
                >{{ zButtonText(offset) }}</Button>
              </div>
            </div>
          </section>

          <Separator />

          <section class="flex flex-col gap-3">
            <h2 class="text-sm font-medium">Corner dots</h2>
            <p class="text-xs text-ink-muted">
              Visits the job bounding-box corners. S0 marks nothing; a higher value fires a
              short pulse.
            </p>

            <div class="grid grid-cols-2 gap-2">
              <Input
                v-model="state.dotPower"
                type="number"
                min="0"
                max="1000"
                step="1"
                mono
                label="Power (S)"
              />
              <Input
                v-model="state.dotMs"
                type="number"
                min="50"
                max="2000"
                step="10"
                mono
                label="Time (ms)"
              />
            </div>

            <Alert v-if="bboxOutOfBed" accent="danger" title="Outside the bed">
              The firing bounding box extends past the 0–220 mm travel. Move or rescale the job
              before marking corners.
            </Alert>

            <div class="flex items-center gap-2">
              <span v-if="!state.job" class="text-xs text-ink-muted">Load a job first.</span>
              <span v-else-if="!state.job.bbox" class="text-xs text-ink-muted">
                This job has no firing bbox.
              </span>

              <Button
                variant="outline"
                :accent="dotPowerNum > 0 ? 'danger' : null"
                size="sm"
                class="ml-auto"
                :disabled="dotsDisabled"
                @click="markCorners"
              >Mark corners</Button>
            </div>
          </section>

          <template v-if="state.job">
            <Separator />

            <section class="flex flex-col gap-3">
              <div class="flex items-center justify-between gap-2">
                <h2 class="text-sm font-medium">Run</h2>
                <Badge v-if="statusBadge" :accent="statusBadge.accent" variant="outline">
                  {{ statusBadge.label }}
                </Badge>
              </div>

              <div class="flex items-end gap-3">
                <div class="w-28">
                  <Input
                    v-model="state.overrideS"
                    type="number"
                    min="0"
                    max="1000"
                    step="1"
                    mono
                    label="Override S"
                    :disabled="!state.overrideEnabled || state.running"
                  />
                </div>
                <Switch
                  v-model="state.overrideEnabled"
                  label="Apply override"
                  :disabled="state.running"
                />
              </div>

              <div class="flex items-center justify-between gap-2">
                <Switch v-model="state.dryRun" label="Dry run (S0)" :disabled="state.running" />
                <span class="font-mono text-xs text-ink-muted">{{ effectivePowerLabel }}</span>
              </div>

              <p class="text-xs text-ink-muted">
                Rewrites nonzero S at send time; S0 stays S0.
              </p>

              <Progress :model-value="progressPct" label="Job progress" />

              <div class="flex items-end justify-between gap-3">
                <div class="min-w-0 flex-1 font-mono text-xs text-ink-muted">
                  <p>{{ state.progress.sent }}/{{ state.progress.total }} lines</p>
                  <p class="truncate" :title="state.currentLine">{{ state.currentLine || "—" }}</p>
                </div>

                <Button v-if="!state.running" :disabled="runDisabled" @click="runJob">
                  Run job
                </Button>
                <Button v-else accent="danger" @click="stopJob">Stop</Button>
              </div>
            </section>
          </template>

          <Separator />

          <section class="flex flex-col gap-3">
            <h2 class="text-sm font-medium">Preview</h2>
            <Select
              v-model="state.powerScale"
              :options="powerScaleOptions"
              label="Power scale"
              size="sm"
            />
            <p class="text-xs text-ink-muted">
              Burn opacity tracks S power. Relative scales to the job's max S; absolute to S1000.
            </p>
          </section>
        </aside>
      </div>

      <div class="px-5 pb-5">
        <LogPane class="h-48" />
      </div>
    </div>

    <Toaster />

    <Dialog
      :open="confirmState.open"
      :title="confirmState.title"
      :description="confirmState.description"
      @update:open="onDialogOpen"
    >
      <div v-if="confirmState.lines.length" class="flex flex-col gap-1 font-mono text-xs text-ink-muted">
        <p v-for="line in confirmState.lines" :key="line">{{ line }}</p>
      </div>

      <template #footer>
        <Button variant="ghost" @click="resolveConfirm(false)">{{ confirmState.cancelLabel }}</Button>
        <Button :accent="confirmState.accent" @click="resolveConfirm(true)">
          {{ confirmState.confirmLabel }}
        </Button>
      </template>
    </Dialog>

    <input
      ref="fileInput"
      type="file"
      accept=".ngc,.gcode,.txt"
      class="hidden"
      @change="onFileChange"
    />
  </div>
</template>