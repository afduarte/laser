import { createApp } from "vue";
import App from "./App.vue";
import { loadSettings } from "./lib/settings.js";

import "./app.css";
import "@reclaim/themes/base.rc.css";
import "@fontsource-variable/geist/index.css";
import "@fontsource-variable/albert-sans/index.css";
import "@fontsource-variable/inconsolata/index.css";

document.documentElement.dataset.rcTheme = "base";

if (loadSettings().dark) {
  document.documentElement.classList.add("dark");
}

createApp(App).mount("#app");
