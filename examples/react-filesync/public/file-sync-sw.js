"use strict";
(() => {
  // src/worker/file-sync-sw.ts
  var defaultConfig = {
    pathPrefix: "/livestore-filesync-files/",
    cacheRemoteResponses: true
  };
  var opfs = {
    async getRoot() {
      try {
        return await navigator.storage.getDirectory();
      } catch {
        return null;
      }
    },
    async getFile(path) {
      const root = await this.getRoot();
      if (!root) return null;
      try {
        const segments = path.split("/").filter((s) => s.length > 0);
        let current = root;
        for (let i = 0; i < segments.length - 1; i++) {
          current = await current.getDirectoryHandle(segments[i]);
        }
        const filename = segments[segments.length - 1];
        const fileHandle = await current.getFileHandle(filename);
        return await fileHandle.getFile();
      } catch {
        return null;
      }
    },
    async writeFile(path, data, mimeType) {
      const root = await this.getRoot();
      if (!root) return false;
      try {
        const segments = path.split("/").filter((s) => s.length > 0);
        let current = root;
        for (let i = 0; i < segments.length - 1; i++) {
          current = await current.getDirectoryHandle(segments[i], { create: true });
        }
        const filename = segments[segments.length - 1];
        const fileHandle = await current.getFileHandle(filename, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(new Blob([data], { type: mimeType }));
        await writable.close();
        return true;
      } catch {
        return false;
      }
    }
  };
  async function handleFileRequest(request, config) {
    const url = new URL(request.url);
    const storedPath = url.pathname.startsWith("/") ? url.pathname.slice(1) : url.pathname;
    const localFile = await opfs.getFile(storedPath);
    if (localFile) {
      return new Response(localFile, {
        headers: {
          "Content-Type": localFile.type || "application/octet-stream",
          "Content-Length": String(localFile.size),
          "X-Source": "opfs"
        }
      });
    }
    if (config.getRemoteUrl) {
      const remoteUrl = await config.getRemoteUrl(storedPath);
      if (remoteUrl) {
        try {
          const remoteHeaders = config.getRemoteHeaders ? await config.getRemoteHeaders(storedPath) : null;
          const response = await fetch(remoteUrl, remoteHeaders ? { headers: remoteHeaders } : void 0);
          if (response.ok) {
            if (config.cacheRemoteResponses) {
              const clonedResponse = response.clone();
              const data = await clonedResponse.arrayBuffer();
              const mimeType = clonedResponse.headers.get("Content-Type") || "application/octet-stream";
              await opfs.writeFile(storedPath, data, mimeType);
            }
            const headers = new Headers(response.headers);
            headers.set("X-Source", "remote");
            return new Response(response.body, {
              status: response.status,
              statusText: response.statusText,
              headers
            });
          }
        } catch (error) {
          console.error("Failed to fetch from remote:", error);
        }
      }
    }
    return new Response("File not found", {
      status: 404,
      headers: { "Content-Type": "text/plain" }
    });
  }
  function initFileSyncServiceWorker(config = {}) {
    const mergedConfig = { ...defaultConfig, ...config };
    self.addEventListener("fetch", (event) => {
      const url = new URL(event.request.url);
      if (event.request.method === "GET" && url.pathname.startsWith(mergedConfig.pathPrefix)) {
        event.respondWith(handleFileRequest(event.request, mergedConfig));
      }
    });
    self.addEventListener("install", () => {
      self.skipWaiting();
    });
    self.addEventListener("activate", (event) => {
      event.waitUntil(self.clients.claim());
    });
    console.log("[FileSyncSW] Initialized with config:", mergedConfig);
  }

  // src/worker/file-sync-sw-standalone.ts
  var params = new URLSearchParams(self.location.search);
  var filesBaseUrl = params.get("filesBaseUrl") || "";
  var token = params.get("token") || "";
  var baseUrl = filesBaseUrl.replace(/\/$/, "");
  initFileSyncServiceWorker({
    pathPrefix: "/livestore-filesync-files/",
    cacheRemoteResponses: true,
    getRemoteUrl: async (path) => baseUrl ? `${baseUrl}/${path}` : `/${path}`,
    ...token ? { getRemoteHeaders: async () => ({ Authorization: `Bearer ${token}` }) } : {}
  });
})();
