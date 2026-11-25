<script setup>
import { computed } from "vue";
import { Badge, Button, Input, Progress, Switch } from "@reclaim/ui";

import {
  canRun,
  effectivePower,
  progressPct,
  runJob,
  running,
  state,
  stopJob,
} from "../lib/store.js";

const effectivePowerLabel = computed(() => {
  if (state.dryRun) return "S0 (dry run)";
  if (!state.overrideEnabled) return "From job";
  return `S${effectivePower.value} override`;
});

const statusBadge = computed(() => {
  if (running.value) return { label: "Running", accent: "brand" };
  if (state.lastStatus === "complete") return { label: "Complete", accent: "success" };
  if (state.lastStatus === "stopped") return { label: "Stopped", accent: "warn" };
  if (state.lastStatus === "error") return { label: "Error", accent: "danger" };
  return null;
});
</script>

<template>
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
          :disabled="!state.overrideEnabled || running"
        />
      </div>
      <Switch
        v-model="state.overrideEnabled"
        label="Apply override"
        :disabled="running"
      />
    </div>

    <div class="flex items-center justify-between gap-2">
      <Switch v-model="state.dryRun" label="Dry run (S0)" :disabled="running" />
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

      <Button v-if="!running" :disabled="!canRun" @click="runJob">
        Run job
      </Button>
      <Button v-else accent="danger" @click="stopJob">Stop</Button>
    </div>
  </section>
</template>
