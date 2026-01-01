import { useEffect, useState, type ReactNode } from "react";
import { useStore } from "@livestore/react";
import { initFileSync } from "@livestore-filesync/core";
import {
  initServiceWorker,
  type ServiceWorkerOptions,
} from "@livestore-filesync/core/worker";
import { layer as opfsLayer } from "@livestore-filesync/opfs";

type FileSyncProviderProps = {
  signerBaseUrl?: string;
  headers?: Record<string, string>;
  authHeaders?: () => Record<string, string>;
  authToken?: string;
  serviceWorker?: boolean | ServiceWorkerOptions;
  children?: ReactNode;
};

export const FileSyncProvider = ({
  signerBaseUrl = "/api",
  headers,
  authHeaders,
  authToken,
  serviceWorker,
  children,
}: FileSyncProviderProps) => {
  const { store } = useStore();
  const [ready, setReady] = useState(!serviceWorker);

  useEffect(() => {
    if (serviceWorker) {
      const swOptions = typeof serviceWorker === "object" ? serviceWorker : {};
      initServiceWorker({ authToken, ...swOptions }).then(() => setReady(true));
    }

    const resolvedHeaders = headers ?? authHeaders?.();
    const dispose = initFileSync(store, {
      fileSystem: opfsLayer(),
      remote: {
        signerBaseUrl,
        ...(resolvedHeaders ? { headers: resolvedHeaders } : {}),
        ...(authToken ? { authToken } : {}),
      },
    });

    return () => void dispose();
  }, [store, signerBaseUrl, headers, authHeaders, authToken, serviceWorker]);

  return ready ? <>{children}</> : null;
};
