import { useEffect, type ReactNode } from "react";
import { useStore } from "@livestore/react";
import {
  disposeFileSync,
  initFileSync,
  startFileSync,
  stopFileSync,
} from "@livestore-filesync/core";

type FileSyncProviderProps = {
  remoteUrl?: string;
  headers?: Record<string, string>;
  authToken?: string;
  children?: ReactNode;
};

export const FileSyncProvider = ({
  remoteUrl = "/api",
  headers,
  authToken,
  children,
}: FileSyncProviderProps) => {
  const { store } = useStore();

  const remote: {
    baseUrl: string;
    headers?: Record<string, string>;
    authToken?: string;
  } = {
    baseUrl: remoteUrl,
  };
  if (headers) {
    remote.headers = headers;
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
  }, [headers, authToken, remoteUrl, store]);

  return <>{children}</>;
};
