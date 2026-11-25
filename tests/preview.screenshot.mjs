// Visual check for the bed preview: renders sample Lasertools jobs and saves
// PNG screenshots (light/dark × relative/absolute power scale).
// No hardware and no running dev server needed — it starts its own Vite.
//   npm run test:shots
// Requires a cached Playwright Chromium (~/.cache/ms-playwright); the
// playwright-core dependency does not download browsers by itself.

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";
import { createServer } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const gcodeDir = path.resolve(here, "../../../laser cutter/gcode");
const outDir = path.join(here, "screenshots");
const PORT = 5199;

const JOBS = ["test_grid.ngc", "test_grid_low.ngc"];

function findChromium() {
  const cacheDir = path.join(os.homedir(), ".cache", "ms-playwright");
  const builds = existsSync(cacheDir)
    ? readdirSync(cacheDir)
        .filter((name) => /^chromium-\d+$/.test(name))
        .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))
    : [];
  for (const build of builds) {
    for (const rel of ["chrome-linux64/chrome", "chrome-linux/chrome"]) {
      const executable = path.join(cacheDir, build, rel);
      if (existsSync(executable)) return executable;
    }
  }
  throw new Error(
    "No cached Playwright Chromium found. Install the `playwright` package and run `npx playwright install chromium`.",
  );
}

// Two animation frames so watchers and the canvas repaint have settled.
function settle(page) {
  return page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}

async function loadJob(page, name) {
  await page.setInputFiles('input[type="file"]', path.join(gcodeDir, name));
  await page.locator("h2", { hasText: name }).waitFor();
  // Let the "G-code loaded" toast expire so it never overlaps the capture.
  await page
    .getByText("G-code loaded")
    .waitFor({ state: "detached", timeout: 5000 })
    .catch(() => {});
  await settle(page);
}

async function shoot(page, name) {
  // The canvas fills its bordered wrapper; capture the wrapper for the frame.
  const preview = page.locator("canvas").locator("xpath=..");
  const file = path.join(outDir, `${name}.png`);
  await preview.screenshot({ path: file });
  console.log(`saved ${path.relative(root, file)}`);
}

mkdirSync(outDir, { recursive: true });

const server = await createServer({
  root,
  logLevel: "silent",
  server: { port: PORT, strictPort: true },
});
await server.listen();

const browser = await chromium.launch({ executablePath: findChromium(), headless: true });

try {
  for (const dark of [false, true]) {
    const theme = dark ? "dark" : "light";
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    await context.addInitScript((isDark) => {
      localStorage.setItem("laser.dark", String(isDark));
      localStorage.setItem("laser.powerScale", "relative");
    }, dark);

    const page = await context.newPage();
    await page.goto(`http://localhost:${PORT}/`);

    for (const job of JOBS) {
      await loadJob(page, job);
      await shoot(page, `${path.basename(job, ".ngc")}--${theme}--relative`);
    }

    // The low-power grid is the interesting absolute-scale case: S10–200
    // against S1000 should render uniformly faint.
    await page.locator('select:has(option[value="absolute"])').selectOption("absolute");
    await settle(page);
    await shoot(page, `test_grid_low--${theme}--absolute`);

    await context.close();
  }
  console.log("preview.screenshot.mjs: all captures saved");
} finally {
  await browser.close();
  await server.close();
}
