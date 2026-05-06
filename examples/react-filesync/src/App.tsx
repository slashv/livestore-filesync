import { StoreRegistry } from "@livestore/livestore"
import { StoreRegistryProvider } from "@livestore/react"
import { useState } from "react"

import { FileSyncProvider } from "./components/FileSyncProvider.tsx"
import { Gallery } from "./components/Gallery.tsx"
import { SyncStatus } from "./components/SyncStatus.tsx"
import { authToken, getAuthHeaders, healthCheckIntervalMs, localOnlyFileSync } from "./livestore/store.ts"

export const App = () => {
  const [storeRegistry] = useState(() => new StoreRegistry())

  return (
    <StoreRegistryProvider storeRegistry={storeRegistry}>
      <FileSyncProvider
        authHeaders={getAuthHeaders}
        authToken={authToken}
        healthCheckIntervalMs={healthCheckIntervalMs}
        localOnly={localOnlyFileSync}
      >
        <div className="app-layout">
          <div className="main">
            <Gallery />
          </div>
          <SyncStatus />
        </div>
      </FileSyncProvider>
    </StoreRegistryProvider>
  )
}
