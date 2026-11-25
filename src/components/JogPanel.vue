<script setup>
import { computed } from "vue";
import { Button, Select } from "@reclaim/ui";

import { canJog, connected, home, jog, state } from "../lib/store.js";

const stepOptions = [
  { value: "0.1", label: "0.1 mm" },
  { value: "1", label: "1 mm" },
  { value: "10", label: "10 mm" },
];

const stepModel = computed({
  get: () => String(state.step),
  set: (value) => {
    state.step = Number(value);
  },
});

const positionLabel = computed(() => {
  if (!connected.value) return "offline";
  if (!state.pos) return "position unknown";
  return `X: ${state.pos.x.toFixed(2)}  Y: ${state.pos.y.toFixed(2)}  Z: ${state.pos.z.toFixed(2)}`;
});
</script>

<template>
  <section class="flex flex-col gap-3">
    <div class="flex items-baseline justify-between gap-3">
      <h2 class="text-sm font-medium">Jog</h2>
      <span class="font-mono text-xs text-ink-muted">{{ positionLabel }}</span>
    </div>

    <div class="flex items-end gap-2">
      <div class="w-28">
        <Select v-model="stepModel" :options="stepOptions" label="Step" size="sm" />
      </div>
      <Button variant="outline" size="sm" :disabled="!canJog" @click="home">
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
          :disabled="!canJog"
          @click="jog('Y', 1)"
        >↑</Button>
        <span></span>

        <Button
          variant="outline"
          icon
          aria-label="Jog X negative"
          :disabled="!canJog"
          @click="jog('X', -1)"
        >←</Button>
        <span class="self-center text-center font-mono text-xs uppercase tracking-widest text-ink-faint">XY</span>
        <Button
          variant="outline"
          icon
          aria-label="Jog X positive"
          :disabled="!canJog"
          @click="jog('X', 1)"
        >→</Button>

        <span></span>
        <Button
          variant="outline"
          icon
          aria-label="Jog Y negative"
          :disabled="!canJog"
          @click="jog('Y', -1)"
        >↓</Button>
        <span></span>
      </div>
    </div>
  </section>
</template>
