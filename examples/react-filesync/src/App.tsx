import { makePersistedAdapter } from "@livestore/adapter-web";
import LiveStoreSharedWorker from "@livestore/adapter-web/shared-worker?sharedworker";
import { LiveStoreProvider } from "@livestore/react";
import { unstable_batchedUpdates as batchUpdates } from "react-dom";

import { schema, SyncPayload } from "./livestore/schema.ts";
import LiveStoreWorker from "./livestore.worker.ts?worker";
import { Gallery } from "./components/Gallery.tsx";
import { FileSyncProvider } from "./components/FileSyncProvider.tsx";

// Allow storeId to be set via query param for testing isolation
const urlParams = new URLSearchParams(window.location.search);
const storeId = urlParams.get("storeId") || "react_filesync_store_2";

const adapter = makePersistedAdapter({
  storage: { type: "opfs" },
  worker: LiveStoreWorker,
  sharedWorker: LiveStoreSharedWorker,
});

const authToken = import.meta.env.VITE_AUTH_TOKEN;

const syncPayload = { authToken };

// Auth headers for file sync API
const getAuthHeaders = () => ({
  Authorization: `Bearer ${authToken}`,
});

export const App = () => (
  <LiveStoreProvider
    schema={schema}
    adapter={adapter}
    storeId={storeId}
    syncPayloadSchema={SyncPayload}
    syncPayload={syncPayload}
    renderLoading={() => <div className="loading">Loading...</div>}
    batchUpdates={batchUpdates}
  >
    <FileSyncProvider authHeaders={getAuthHeaders} authToken={authToken} serviceWorker>
      <Gallery />
    </FileSyncProvider>
  </LiveStoreProvider>
);
