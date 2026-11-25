import { createApp } from "vue";
import App from "./App.vue";

import "./app.css";
import "@reclaim/themes/base.rc.css";
import "@fontsource-variable/geist/index.css";
import "@fontsource-variable/albert-sans/index.css";
import "@fontsource-variable/inconsolata/index.css";

document.documentElement.dataset.rcTheme = "base";

if (localStorage.getItem("laser.dark") === "true") {
  document.documentElement.classList.add("dark");
}

createApp(App).mount("#app");
