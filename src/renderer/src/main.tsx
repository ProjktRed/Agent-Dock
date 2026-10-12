import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { AppProvider } from "./store";
import { App } from "./App";

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
