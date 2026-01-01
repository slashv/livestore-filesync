import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./index.css";

import { registerFileSyncServiceWorker } from "@livestore-filesync/core/worker";

const authToken = import.meta.env.VITE_AUTH_TOKEN;
const swUrl = new URL("/file-sync-sw.js", window.location.origin);
swUrl.searchParams.set("filesBaseUrl", window.location.origin);
if (authToken) {
  swUrl.searchParams.set("token", authToken);
}

// Register service worker and wait for it to be ready before rendering
// This ensures the SW is active to intercept file requests
const initApp = async () => {
  await registerFileSyncServiceWorker({
    scriptUrl: swUrl.toString(),
    // No type: "module" - bundled SW works in all browsers including Firefox
  });

  // Wait for service worker to be ready (important for Firefox)
  if ("serviceWorker" in navigator) {
    await navigator.serviceWorker.ready;
  }

  const rootElement = document.getElementById("root");
  if (!rootElement) {
    throw new Error("Root element not found");
  }

  createRoot(rootElement).render(<App />);
};

void initApp();
