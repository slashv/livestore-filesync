import { useEffect, type ReactNode } from "react";
import { useStore } from "@livestore/react";
import {
  disposeFileSync,
  initFileSync,
  startFileSync,
  stopFileSync,
} from "@livestore-filesync/core";

type FileSyncProviderProps = {
  signerBaseUrl?: string;
  headers?: Record<string, string>;
  authHeaders?: () => Record<string, string>;
  authToken?: string;
  children?: ReactNode;
};

export const FileSyncProvider = ({
  signerBaseUrl = "/api",
  headers,
  authHeaders,
  authToken,
  children,
}: FileSyncProviderProps) => {
  const { store } = useStore();

  const remote: {
    signerBaseUrl: string;
    headers?: Record<string, string>;
    authToken?: string;
  } = {
    signerBaseUrl,
  };

  const resolvedHeaders = headers ?? authHeaders?.();
  if (resolvedHeaders) {
    remote.headers = resolvedHeaders;
  }
  if (authToken) {
    remote.authToken = authToken;
  }
  initFileSync(store, { remote });

  useEffect(() => {
    startFileSync();

    return () => {
      stopFileSync();
      void disposeFileSync();
    };
  }, [headers, authHeaders, authToken, signerBaseUrl, store]);

  return <>{children}</>;
};
