import { expect, type Page, type Locator } from '@playwright/test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const currentDir = path.dirname(fileURLToPath(import.meta.url))

export const authToken =
  process.env.FILESYNC_AUTH_TOKEN ??
  process.env.VITE_AUTH_TOKEN ??
  process.env.WORKER_AUTH_TOKEN ??
  'dev-token-change-in-production'

export const authHeaders = authToken ? { Authorization: `Bearer ${authToken}` } : {}

/**
 * Create a test image by copying from fixtures.
 * Returns the path to the temporary image file.
 */
export function createTestImage(
  color: 'blue' | 'red',
  opts: { suffix?: string } = {}
): string {
  const fixturesDir = path.resolve(currentDir, '../fixtures/images')
  const fixturePath = path.join(fixturesDir, `${color}.png`)

  const imagePath = path.join(
    os.tmpdir(),
    `test-${color}-${opts.suffix ?? Date.now()}-${Math.random().toString(36).slice(2)}.png`
  )

  fs.copyFileSync(fixturePath, imagePath)
  return imagePath
}

/**
 * Create multiple test images with unique suffixes.
 */
export function createMultipleTestImages(count: number): string[] {
  return Array.from({ length: count }, (_, i) =>
    createTestImage(i % 2 === 0 ? 'blue' : 'red', { suffix: `multi-${i}-${Date.now()}` })
  )
}

/**
 * Wait for LiveStore to finish loading.
 */
export async function waitForLiveStore(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !document.body.innerText.includes('Loading LiveStore'),
    { timeout: 60000 }
  )
  await page.waitForSelector('[data-testid="gallery"]', { timeout: 30000 })
}

/**
 * Wait for LiveStore to finish loading AND initial sync to complete.
 * This waits for the sync status to show no pending operations.
 */
export async function waitForLiveStoreAndSync(page: Page): Promise<void> {
  await waitForLiveStore(page)
  
  // Wait for sync status panel to be visible
  await page.waitForSelector('[data-testid="sync-status-panel"]', { timeout: 30000 })
  
  // Wait for sync to not be in progress (isSyncing = No, hasPending = No)
  await expect.poll(
    async () => {
      const isSyncing = await page.locator('[data-testid="sync-is-syncing"]').textContent()
      const hasPending = await page.locator('[data-testid="sync-has-pending"]').textContent()
      return isSyncing === 'No' && hasPending === 'No'
    },
    { timeout: 30000, intervals: [100, 250, 500] }
  ).toBe(true)
}

/**
 * Wait for an image element to be fully loaded.
 */
export async function waitForImageLoaded(
  locator: Locator,
  timeoutMs = 10000
): Promise<void> {
  await expect(locator).toBeVisible({ timeout: timeoutMs })
  await expect.poll(
    async () =>
      locator.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
    { timeout: timeoutMs }
  ).toBe(true)
}

/**
 * Add cache-busting query parameter to a URL.
 */
export function withCacheBust(url: string): string {
  const next = new URL(url)
  next.searchParams.set('cache', Date.now().toString())
  return next.toString()
}

/**
 * Get the remote key from the file card.
 */
export async function getRemoteKey(page: Page): Promise<string> {
  const locator = page.locator('[data-testid="file-remote-key"]')
  await expect(locator).toBeVisible({ timeout: 10000 })
  await expect.poll(async () => (await locator.textContent())?.trim() || '', { timeout: 15000 }).not.toBe('')
  return (await locator.textContent())?.trim() || ''
}

/**
 * Convert a remote key to a full URL.
 */
export function toRemoteUrl(baseUrl: string, remoteKey: string): string {
  const encoded = remoteKey
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => encodeURIComponent(s))
    .join('/')
  return new URL(`/livestore-filesync-files/${encoded}`, baseUrl).toString()
}

/**
 * Poll until the remote file returns the expected HTTP status.
 */
export async function waitForRemoteStatus(
  page: Page,
  fileUrl: string,
  expectedStatus: number
): Promise<void> {
  await expect.poll(
    async () => {
      const response = await page.request.get(withCacheBust(fileUrl), {
        headers: authHeaders as Record<string, string> | undefined,
      })
      return response.status()
    },
    { timeout: 5000 }
  ).toBe(expectedStatus)
}

/**
 * Generate a unique store ID for test isolation.
 */
export function generateStoreId(prefix = 'test'): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`
}

// ============================================
// Sync Status Helpers
// ============================================

/**
 * Sync status counts from the UI.
 */
export interface SyncStatusCounts {
  uploading: number
  downloading: number
  queuedUpload: number
  queuedDownload: number
  pendingUpload: number
  pendingDownload: number
  errors: number
  isSyncing: boolean
  hasPending: boolean
}

/**
 * Get sync status counts from the UI.
 */
export async function getSyncStatusCounts(page: Page): Promise<SyncStatusCounts> {
  const getText = async (testId: string): Promise<string> => {
    const locator = page.locator(`[data-testid="${testId}"]`)
    return (await locator.textContent()) || ''
  }

  return {
    uploading: parseInt(await getText('sync-uploading-count')) || 0,
    downloading: parseInt(await getText('sync-downloading-count')) || 0,
    queuedUpload: parseInt(await getText('sync-queued-upload-count')) || 0,
    queuedDownload: parseInt(await getText('sync-queued-download-count')) || 0,
    pendingUpload: parseInt(await getText('sync-pending-upload-count')) || 0,
    pendingDownload: parseInt(await getText('sync-pending-download-count')) || 0,
    errors: parseInt(await getText('sync-error-count')) || 0,
    isSyncing: (await getText('sync-is-syncing')) === 'Yes',
    hasPending: (await getText('sync-has-pending')) === 'Yes',
  }
}

/**
 * Get total count of files in any upload state.
 */
export function getTotalUploadingCount(status: SyncStatusCounts): number {
  return status.uploading + status.queuedUpload + status.pendingUpload
}

/**
 * Get total count of files in any download state.
 */
export function getTotalDownloadingCount(status: SyncStatusCounts): number {
  return status.downloading + status.queuedDownload + status.pendingDownload
}

// ============================================
// Offline/Online Simulation Helpers
// ============================================

/**
 * Set the page to offline mode.
 * This sets both:
 * - Playwright's context offline (blocks network requests)
 * - LiveStore's internal sync latch (stops LiveStore sync)
 */
export async function setOffline(page: Page): Promise<void> {
  // First, set LiveStore to offline mode via _dev API
  await page.evaluate(() => {
    const store = (window as any).__debugLiveStore?.default
    if (store?._dev?.overrideNetworkStatus) {
      store._dev.overrideNetworkStatus('offline')
    }
  })

  // Then set Playwright context offline
  const context = page.context()
  await context.setOffline(true)
}

/**
 * Set the page to online mode.
 * This sets both:
 * - Playwright's context online (allows network requests)
 * - LiveStore's internal sync latch (resumes LiveStore sync)
 * Also dispatches browser online event to trigger FileSync recovery.
 */
export async function setOnline(page: Page): Promise<void> {
  // First, set Playwright context online
  const context = page.context()
  await context.setOffline(false)

  // Then set LiveStore to online mode via _dev API
  await page.evaluate(() => {
    const store = (window as any).__debugLiveStore?.default
    if (store?._dev?.overrideNetworkStatus) {
      store._dev.overrideNetworkStatus('online')
    }
    // Also dispatch online event to trigger FileSync recovery
    window.dispatchEvent(new Event('online'))
  })
}
