<script setup>
import { computed } from "vue";
import { Button, Input } from "@reclaim/ui";

import { Z_MAX, canJog, connected, moveToZ, nudgeZ, state } from "../lib/store.js";

const zOffsets = [-100, -10, -1, 0, 1, 10, 100];

function zButtonText(offset) {
  return offset > 0 ? `+${offset}` : String(offset);
}

function zButtonLabel(offset) {
  if (offset === 0) return "Move Z to the entered value";
  return `Move Z ${offset > 0 ? "up" : "down"} ${Math.abs(offset)} mm`;
}

const currentZLabel = computed(() => {
  if (!connected.value) return "offline";
  if (!state.pos) return "unknown";
  return `${state.pos.z.toFixed(2)} mm`;
});
</script>

<template>
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
          :disabled="!canJog"
          :aria-label="zButtonLabel(offset)"
          :title="zButtonLabel(offset)"
          @click="offset === 0 ? moveToZ() : nudgeZ(offset)"
        >{{ zButtonText(offset) }}</Button>
      </div>
    </div>
  </section>
</template>
