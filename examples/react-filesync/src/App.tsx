import { makePersistedAdapter } from "@livestore/adapter-web";
import LiveStoreSharedWorker from "@livestore/adapter-web/shared-worker?sharedworker";
import { StoreRegistry, storeOptions } from "@livestore/livestore";
import { StoreRegistryProvider } from "@livestore/react";
import { unstable_batchedUpdates as batchUpdates } from "react-dom";

import { schema, SyncPayload } from "./livestore/schema.ts";
import LiveStoreWorker from "./livestore.worker.ts?worker";
import { Gallery } from "./components/Gallery.tsx";
import { FileSyncProvider } from "./components/FileSyncProvider.tsx";
import { SyncStatus } from "./components/SyncStatus.tsx";

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

const storeRegistry = new StoreRegistry({ defaultOptions: { batchUpdates } });

export const reactStoreOptions = storeOptions({
  schema,
  adapter,
  storeId,
  syncPayloadSchema: SyncPayload,
  syncPayload,
});

export const App = () => (
  <StoreRegistryProvider storeRegistry={storeRegistry}>
    <FileSyncProvider authHeaders={getAuthHeaders} authToken={authToken} serviceWorker>
      <div className="app-layout">
        <div className="main">
          <Gallery />
        </div>
        <SyncStatus />
      </div>
    </FileSyncProvider>
  </StoreRegistryProvider>
);
