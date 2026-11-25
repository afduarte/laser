<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { Alert, Badge, Button, Checkbox, Dialog, Select, Separator, Toaster } from "@reclaim/ui";

import BedPreview from "./components/BedPreview.vue";
import DotsPanel from "./components/DotsPanel.vue";
import JogPanel from "./components/JogPanel.vue";
import LogPane from "./components/LogPane.vue";
import RunPanel from "./components/RunPanel.vue";
import ZPanel from "./components/ZPanel.vue";
import { confirmState, resolveConfirm } from "./lib/confirm.js";
import {
  connect,
  connected,
  disconnect,
  laserOffNow,
  loadFile,
  marlin,
  running,
  state,
  toggleDark,
} from "./lib/store.js";

const fileInput = ref(null);

const powerScaleOptions = [
  { value: "relative", label: "Relative (job max)" },
  { value: "absolute", label: "Absolute (S1000)" },
];

const jobBbox = computed(() => {
  const bbox = state.job?.bbox;
  if (!bbox) return "";
  const width = (bbox.maxX - bbox.minX).toFixed(1);
  const height = (bbox.maxY - bbox.minY).toFixed(1);
  return `${width} × ${height} mm @ ${bbox.minX.toFixed(1)}, ${bbox.minY.toFixed(1)}`;
});

const connectionBadge = computed(() => {
  if (state.status === "connecting") return { label: "Connecting", accent: "warn" };
  if (state.status === "disconnecting") return { label: "Disconnecting", accent: "warn" };
  if (connected.value) return { label: "Connected", accent: "success" };
  return { label: "Disconnected", accent: null };
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
        <Badge v-if="connected && !state.homed" accent="warn">Not homed</Badge>
        <Badge v-if="running" accent="brand">Running</Badge>
      </div>

      <div class="ml-auto flex flex-wrap items-center gap-2">
        <Button
          v-if="connected"
          variant="outline"
          accent="danger"
          size="sm"
          @click="laserOffNow"
        >Laser off</Button>

        <Button
          v-if="connected"
          variant="outline"
          size="sm"
          :loading="state.status === 'disconnecting'"
          @click="disconnect"
        >Disconnect</Button>
        <Button
          v-else
          size="sm"
          :loading="state.status === 'connecting'"
          @click="connect"
        >Connect</Button>

        <Button
          variant="outline"
          size="sm"
          :disabled="running"
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
          <JogPanel />
          <Separator />
          <ZPanel />
          <Separator />
          <DotsPanel />

          <template v-if="state.job">
            <Separator />
            <RunPanel />
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
