// Promise-based confirmation dialog. The App renders one Dialog bound to
// `confirmState`; store actions await `confirmDialog(...)`.
// Only one dialog can be open at a time: a new request cancels the previous
// one with `false` so no caller is left waiting on a dismissed dialog.

import { reactive } from "vue";

export const confirmState = reactive({
  open: false,
  title: "",
  description: "",
  lines: [],
  confirmLabel: "Continue",
  cancelLabel: "Cancel",
  accent: null,
});

let confirmResolve = null;

export function confirmDialog(options = {}) {
  return new Promise((resolve) => {
    if (confirmResolve) confirmResolve(false);
    Object.assign(confirmState, {
      open: true,
      title: options.title ?? "Confirm",
      description: options.description ?? "",
      lines: options.lines ?? [],
      confirmLabel: options.confirmLabel ?? "Continue",
      cancelLabel: options.cancelLabel ?? "Cancel",
      accent: options.accent ?? null,
    });
    confirmResolve = resolve;
  });
}

export function resolveConfirm(value) {
  confirmState.open = false;
  const resolve = confirmResolve;
  confirmResolve = null;
  resolve?.(Boolean(value));
}
