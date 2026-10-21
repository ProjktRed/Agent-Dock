import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Bundled web fonts (latin, only the weights in use), so the app never fetches them online.
// Standard: Inter and JetBrains Mono. Cyberpunk: Chakra Petch, Orbitron (headings, brand) and JetBrains Mono.
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/latin-700.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "@fontsource/chakra-petch/latin-400.css";
import "@fontsource/chakra-petch/latin-500.css";
import "@fontsource/chakra-petch/latin-600.css";
import "@fontsource/chakra-petch/latin-700.css";
import "@fontsource/orbitron/latin-600.css";
import "@fontsource/orbitron/latin-800.css";
import "./styles.css";
import "./styles-standard.css";
import "./styles-cyberpunk.css";
import { AppProvider } from "./store";
import { App } from "./App";
import { UI_STYLES } from "@shared/appearance";
import type { UiStyle } from "@shared/types";

// The main process passes the saved style, shade and accent on the query string: apply them before the
// settings snapshot arrives, so the first paint is already in the right style.
const look = new URLSearchParams(location.search);
const ui = look.get("ui") as UiStyle | null;
if (ui && UI_STYLES.includes(ui)) document.documentElement.dataset.ui = ui;
if (look.get("theme") === "darker") document.documentElement.dataset.theme = "darker";
const accent = look.get("accent");
if (accent && /^#[0-9a-f]{6}$/i.test(accent)) document.documentElement.style.setProperty("--a", accent);

const root = createRoot(document.getElementById("root")!);

window.api
  .snapshot()
  .then((snapshot) =>
    root.render(
      <StrictMode>
        <AppProvider initial={snapshot}>
          <App />
        </AppProvider>
      </StrictMode>,
    ),
  )
  .catch((error) => {
    root.render(<div style={{ padding: 32, color: "#E3949F" }}>Failed to load application state: {String(error)}</div>);
  });
