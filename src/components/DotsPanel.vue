<script setup>
import { computed } from "vue";
import { Alert, Button, Input } from "@reclaim/ui";

import { bboxOutOfBed, canDots, markCorners, state } from "../lib/store.js";

const dotPowerNum = computed(() => {
  const value = Number(state.dotPower);
  return Number.isFinite(value) ? value : 0;
});
</script>

<template>
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
        :disabled="!canDots"
        @click="markCorners"
      >Mark corners</Button>
    </div>
  </section>
</template>
