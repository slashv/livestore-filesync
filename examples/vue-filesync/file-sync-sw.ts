/// <reference lib="webworker" />

import { initFileSyncServiceWorker } from "@livestore-filesync/core/worker"

const params = new URLSearchParams(self.location.search)
const filesBaseUrl = params.get("filesBaseUrl") || ""
const token = params.get("token") || ""
const baseUrl = filesBaseUrl.replace(/\/$/, "")

initFileSyncServiceWorker({
  pathPrefix: "/livestore-filesync-files/",
  cacheRemoteResponses: true,
  getRemoteUrl: async (path) => (baseUrl ? `${baseUrl}/${path}` : `/${path}`),
  getRemoteHeaders: token ? async () => ({ Authorization: `Bearer ${token}` }) : undefined
})
