import { expect, type Page, type Locator } from '@playwright/test'
import * as crypto from 'node:crypto'
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
  opts: { suffix?: string; format?: 'png' | 'jpg' } = {}
): string {
  const format = opts.format ?? 'png'
  const fixturesDir = path.resolve(currentDir, '../fixtures/images')
  const fixturePath = path.join(fixturesDir, `${color}.${format}`)

  const imagePath = path.join(
    os.tmpdir(),
    `test-${color}-${opts.suffix ?? Date.now()}-${Math.random().toString(36).slice(2)}.${format}`
  )

  fs.copyFileSync(fixturePath, imagePath)
  return imagePath
}

/**
 * Create a test file that is NOT an image (for testing unsupported file types).
 * Returns the path to the temporary text file.
 */
export function createTestTextFile(opts: { suffix?: string } = {}): string {
  const fixturesDir = path.resolve(currentDir, '../fixtures/images')
  const fixturePath = path.join(fixturesDir, 'test.txt')

  const filePath = path.join(
    os.tmpdir(),
    `test-text-${opts.suffix ?? Date.now()}-${Math.random().toString(36).slice(2)}.txt`
  )

  fs.copyFileSync(fixturePath, filePath)
  return filePath
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
 * Create a test image with unique content by appending random bytes.
 * This ensures each image has a different content hash, useful for testing
 * scenarios where multiple files should have unique OPFS paths.
 */
export function createUniqueTestImage(
  color: 'blue' | 'red',
  index: number
): string {
  const format = 'png'
  const fixturesDir = path.resolve(currentDir, '../fixtures/images')
  const fixturePath = path.join(fixturesDir, `${color}.${format}`)

  const imagePath = path.join(
    os.tmpdir(),
    `test-unique-${color}-${index}-${Date.now()}-${Math.random().toString(36).slice(2)}.${format}`
  )

  // Read fixture and append random bytes to make hash unique
  const content = fs.readFileSync(fixturePath)
  const randomBytes = crypto.randomBytes(32)
  const uniqueContent = Buffer.concat([content, randomBytes])
  fs.writeFileSync(imagePath, uniqueContent)

  return imagePath
}

/**
 * Create multiple test images with unique content (different hashes).
 * Each file will have a unique content hash and therefore a unique OPFS path.
 */
export function createMultipleUniqueTestImages(count: number): string[] {
  return Array.from({ length: count }, (_, i) =>
    createUniqueTestImage(i % 2 === 0 ? 'blue' : 'red', i)
  )
}

/**
 * Create a large test image by copying from the large-images fixtures.
 * These are real photos (2-8MB each) useful for testing with realistic file sizes.
 * Available indices: 1-8
 */
export function createLargeTestImage(index: number): string {
  const fixturesDir = path.resolve(currentDir, '../fixtures/large-images')
  // Clamp index to 1-8 range
  const imageIndex = ((index - 1) % 8) + 1
  const fixturePath = path.join(fixturesDir, `${imageIndex}.jpeg`)

  const imagePath = path.join(
    os.tmpdir(),
    `test-large-${imageIndex}-${Date.now()}-${Math.random().toString(36).slice(2)}.jpeg`
  )

  fs.copyFileSync(fixturePath, imagePath)
  return imagePath
}

/**
 * Create multiple large test images.
 * Each image is a different large photo (2-8MB each).
 */
export function createMultipleLargeTestImages(count: number): string[] {
  return Array.from({ length: count }, (_, i) => createLargeTestImage(i + 1))
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
 * This:
 * - Sets Playwright's context offline to block network requests
 * - Dispatches window 'offline' event directly in browser context
 * - Toggles LiveStore sync via UI button
 */
export async function setOffline(page: Page): Promise<void> {
  // Set Playwright context offline to block actual network requests
  const context = page.context()
  await context.setOffline(true)

  // Dispatch the offline event directly in the browser context
  // This triggers the FileSync online/offline handling
  await page.evaluate(() => {
    window.dispatchEvent(new Event('offline'))
  })

  // Click the LiveStore Sync button to disable sync (if currently enabled)
  const liveStoreSyncButton = page.locator('[data-testid="toggle-livestore-sync"]')
  const liveStoreSyncText = await liveStoreSyncButton.textContent()
  if (liveStoreSyncText?.trim() === 'Enabled') {
    await liveStoreSyncButton.click()
  }

  // Small delay to ensure events are processed
  await page.waitForTimeout(100)
}

/**
 * Set the page to online mode.
 * This:
 * - Sets Playwright's context online to allow network requests
 * - Toggles LiveStore sync via UI button
 * - Dispatches window 'online' event directly in browser context
 */
export async function setOnline(page: Page): Promise<void> {
  // First, set Playwright context online to allow network requests
  const context = page.context()
  await context.setOffline(false)

  // Click the LiveStore Sync button to enable sync (if currently disabled)
  const liveStoreSyncButton = page.locator('[data-testid="toggle-livestore-sync"]')
  const liveStoreSyncText = await liveStoreSyncButton.textContent()
  if (liveStoreSyncText?.trim() === 'Disabled') {
    await liveStoreSyncButton.click()
  }

  // Dispatch the online event directly in the browser context
  // This triggers FileSync recovery and resumes the executor
  await page.evaluate(() => {
    window.dispatchEvent(new Event('online'))
  })

  // Small delay to ensure events are processed and FileSync resumes
  await page.waitForTimeout(100)
}
