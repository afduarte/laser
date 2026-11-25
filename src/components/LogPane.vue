<script setup>
import { nextTick, ref, watch } from "vue";
import { Button } from "@reclaim/ui";

import { state } from "../lib/store.js";

const box = ref(null);

watch(
  () => state.log.length,
  async () => {
    await nextTick();
    const el = box.value;
    if (el) el.scrollTop = el.scrollHeight;
  },
  { flush: "post" },
);

const TONE_CLASS = {
  normal: "text-ink-muted",
  out: "text-ink",
  warn: "text-warn",
  error: "text-danger",
};

function toneClass(tone) {
  return TONE_CLASS[tone] ?? TONE_CLASS.normal;
}

function clear() {
  state.log.splice(0, state.log.length);
}
</script>

<template>
  <section class="flex min-h-0 flex-col overflow-hidden rounded-rc border border-line bg-surface">
    <div class="flex items-center justify-between border-b border-line px-3 py-1.5">
      <h2 class="text-xs font-medium">Console</h2>
      <Button variant="ghost" size="sm" :disabled="!state.log.length" @click="clear">Clear</Button>
    </div>
    <div ref="box" class="min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-xs leading-relaxed">
      <p v-if="!state.log.length" class="text-ink-faint">No serial traffic yet.</p>
      <div
        v-for="(line, index) in state.log"
        :key="index"
        class="whitespace-pre-wrap break-all"
        :class="toneClass(line.tone)"
      >{{ line.text }}</div>
    </div>
  </section>
</template>