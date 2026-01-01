import { test, expect, type Page, type Locator } from '@playwright/test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const authToken =
  process.env.FILESYNC_AUTH_TOKEN ??
  process.env.VITE_AUTH_TOKEN ??
  process.env.WORKER_AUTH_TOKEN ??
  'dev-token-change-in-production'
const authHeaders = authToken ? { Authorization: `Bearer ${authToken}` } : {}

const currentDir = path.dirname(fileURLToPath(import.meta.url))

function createTestImage(
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

async function waitForLiveStore(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !document.body.innerText.includes('Loading LiveStore'),
    { timeout: 60000 }
  )
  await page.waitForSelector('[data-testid="gallery"]', { timeout: 30000 })
}

async function waitForImageLoaded(
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

function withCacheBust(url: string): string {
  const next = new URL(url)
  next.searchParams.set('cache', Date.now().toString())
  return next.toString()
}

async function getRemoteKey(page: Page): Promise<string> {
  const locator = page.locator('[data-testid="file-remote-key"]')
  await expect(locator).toBeVisible({ timeout: 10000 })
  await expect.poll(async () => (await locator.textContent())?.trim() || '', { timeout: 15000 }).not.toBe('')
  return (await locator.textContent())?.trim() || ''
}

function toRemoteUrl(baseUrl: string, remoteKey: string): string {
  const encoded = remoteKey
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => encodeURIComponent(s))
    .join('/')
  return new URL(`/livestore-filesync-files/${encoded}`, baseUrl).toString()
}

async function waitForRemoteStatus(
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
    { timeout: 2000 }
  ).toBe(expectedStatus)
}

test.describe('File Sync', () => {
  test('should add a file', async ({ page }) => {
    // Use a unique storeId for test isolation
    const storeId = `test_${Date.now()}_${Math.random().toString(36).slice(2)}`
    await page.goto(`/?storeId=${storeId}`)
    await waitForLiveStore(page)

    // Verify we start with empty state
    await expect(page.locator('[data-testid="empty-state"]')).toBeVisible()

    // Upload a file
    const testImage = createTestImage('blue')
    await page.locator('input[type="file"]').setInputFiles(testImage)

    // Wait for file card to appear
    await expect(page.locator('[data-testid="file-card"]')).toHaveCount(1, {
      timeout: 10000,
    })
    await waitForImageLoaded(page.locator('[data-testid="file-image"]'), 10000)
  })

  test('should delete files from remote storage', async ({ page }) => {
    const storeId = `test_${Date.now()}_${Math.random().toString(36).slice(2)}`
    await page.goto(`/?storeId=${storeId}`)
    await waitForLiveStore(page)

    await expect(page.locator('[data-testid="empty-state"]')).toBeVisible()

    const testImage = createTestImage('red')
    await page.locator('input[type="file"]').setInputFiles(testImage)

    const fileCard = page.locator('[data-testid="file-card"]')
    const fileImage = page.locator('[data-testid="file-image"]')

    await expect(fileCard).toHaveCount(1)
    await waitForImageLoaded(fileImage, 2000)

    const remoteKey = await getRemoteKey(page)
    const fileUrl = toRemoteUrl(page.url(), remoteKey)
    await waitForRemoteStatus(page, fileUrl, 200)

    await page.locator('[data-testid="delete-button"]').click()

    await expect(fileCard).toHaveCount(0, { timeout: 2000 })
    await expect(page.locator('[data-testid="empty-state"]')).toBeVisible()

    await waitForRemoteStatus(page, fileUrl, 404)
  })

  test('should sync files across browsers', async ({ browser }) => {
    // Use a unique storeId shared between both browsers
    const storeId = `test_${Date.now()}_${Math.random().toString(36).slice(2)}`
    const url = `/?storeId=${storeId}`

    // Create two separate browser contexts (simulates two different users/browsers)
    const context1 = await browser.newContext()
    const context2 = await browser.newContext()

    const page1 = await context1.newPage()
    const page2 = await context2.newPage()

    // Navigate both to the app with the same storeId
    await page1.goto(url)
    await page2.goto(url)

    await waitForLiveStore(page1)
    await waitForLiveStore(page2)

    // Verify both start with empty state
    await expect(page1.locator('[data-testid="empty-state"]')).toBeVisible()
    await expect(page2.locator('[data-testid="empty-state"]')).toBeVisible()

    // Upload a file in browser 1
    const testImage = createTestImage('blue')
    await page1.locator('input[type="file"]').setInputFiles(testImage)

    // Wait for file to appear in browser 1 with image loaded
    await expect(page1.locator('[data-testid="file-card"]')).toHaveCount(1, {
      timeout: 10000,
    })
    await waitForImageLoaded(page1.locator('[data-testid="file-image"]'), 10000)

    // Verify file syncs to browser 2 with image loaded
    await expect(page2.locator('[data-testid="file-card"]')).toHaveCount(1, {
      timeout: 15000,
    })
    await waitForImageLoaded(page2.locator('[data-testid="file-image"]'), 15000)

    // Cleanup
    await context1.close()
    await context2.close()
  })

  test('should sync edited images across browsers', async ({ browser }) => {
    const storeId = `test_${Date.now()}_${Math.random().toString(36).slice(2)}`
    const url = `/?storeId=${storeId}`

    const context1 = await browser.newContext()
    const context2 = await browser.newContext()

    const page1 = await context1.newPage()
    const page2 = await context2.newPage()

    await page1.goto(url)
    await page2.goto(url)

    await waitForLiveStore(page1)
    await waitForLiveStore(page2)

    const testImage = createTestImage('red')
    await page1.locator('input[type="file"]').setInputFiles(testImage)

    const page1Image = page1.locator('[data-testid="file-image"]')
    const page2Image = page2.locator('[data-testid="file-image"]')

    await expect(page1.locator('[data-testid="file-card"]')).toHaveCount(1, {
      timeout: 10000,
    })
    await waitForImageLoaded(page1Image, 10000)

    await expect(page2.locator('[data-testid="file-card"]')).toHaveCount(1, {
      timeout: 15000,
    })
    await waitForImageLoaded(page2Image, 15000)

    const initialSrc = await page2Image.getAttribute('src')
    expect(initialSrc).not.toBeNull()

    await page1.locator('[data-testid="edit-button"]').click()

    await expect
      .poll(async () => page2Image.getAttribute('src'), { timeout: 15000 })
      .not.toBe(initialSrc)

    await waitForImageLoaded(page2Image, 15000)

    await context1.close()
    await context2.close()
  })

  test('originating client should display file immediately while upload is pending', async ({ browser }) => {
    const storeId = `test_${Date.now()}_${Math.random().toString(36).slice(2)}`
    const url = `/?storeId=${storeId}`

    const context = await browser.newContext()
    const page = await context.newPage()

    // Intercept PUT requests to the files endpoint and delay them
    let uploadResolve: (() => void) | null = null
    const uploadStarted = new Promise<void>((resolve) => {
      uploadResolve = resolve
    })

    await page.route('**/livestore-filesync-files/**', async (route) => {
      if (route.request().method() === 'PUT') {
        // Signal that upload has started
        uploadResolve?.()
        // Delay the upload by 2 seconds
        await new Promise((resolve) => setTimeout(resolve, 2000))
      }
      await route.continue()
    })

    await page.goto(url)
    await waitForLiveStore(page)

    const testImage = createTestImage('blue')
    await page.locator('input[type="file"]').setInputFiles(testImage)

    // Wait for file card to appear
    await expect(page.locator('[data-testid="file-card"]')).toHaveCount(1, {
      timeout: 5000,
    })

    // Wait for upload to start (but not complete)
    await uploadStarted

    // Verify canDisplay is true (because we have local copy)
    await expect(page.locator('[data-testid="file-can-display"]')).toHaveText('true', {
      timeout: 2000,
    })

    // Verify image is displayed immediately (from OPFS)
    const image = page.locator('[data-testid="file-image"]')
    await waitForImageLoaded(image, 5000)

    // Verify upload status shows uploading
    const uploadStatus = page.locator('[data-testid="file-upload-status"]')
    const status = await uploadStatus.textContent()
    expect(['queued', 'inProgress']).toContain(status?.trim())

    // Wait for upload to complete and verify status changes to done
    await expect(uploadStatus).toHaveText('done', { timeout: 10000 })

    await context.close()
  })

  test('other clients should show placeholder while file is uploading', async ({ browser }) => {
    const storeId = `test_${Date.now()}_${Math.random().toString(36).slice(2)}`
    const url = `/?storeId=${storeId}`

    const context1 = await browser.newContext()
    const context2 = await browser.newContext()

    const page1 = await context1.newPage()
    const page2 = await context2.newPage()

    // Intercept PUT requests on page1 to delay uploads
    let uploadResolve: (() => void) | null = null
    const uploadComplete = new Promise<void>((resolve) => {
      uploadResolve = resolve
    })

    await page1.route('**/livestore-filesync-files/**', async (route) => {
      if (route.request().method() === 'PUT') {
        // Delay the upload by 3 seconds
        await new Promise((resolve) => setTimeout(resolve, 3000))
        uploadResolve?.()
      }
      await route.continue()
    })

    await page1.goto(url)
    await page2.goto(url)

    await waitForLiveStore(page1)
    await waitForLiveStore(page2)

    const testImage = createTestImage('red')
    await page1.locator('input[type="file"]').setInputFiles(testImage)

    // Page1: should display immediately (has local copy)
    await expect(page1.locator('[data-testid="file-card"]')).toHaveCount(1, {
      timeout: 5000,
    })
    await expect(page1.locator('[data-testid="file-can-display"]')).toHaveText('true', {
      timeout: 2000,
    })
    await waitForImageLoaded(page1.locator('[data-testid="file-image"]'), 5000)

    // Page2: should see file card appear (LiveStore syncs metadata)
    await expect(page2.locator('[data-testid="file-card"]')).toHaveCount(1, {
      timeout: 5000,
    })

    // Page2: canDisplay should be false (no local copy, no remote yet)
    await expect(page2.locator('[data-testid="file-can-display"]')).toHaveText('false', {
      timeout: 2000,
    })

    // Page2: should show placeholder, not image
    await expect(page2.locator('[data-testid="file-placeholder"]')).toBeVisible()
    await expect(page2.locator('[data-testid="file-image"]')).not.toBeVisible()

    // Wait for upload to complete
    await uploadComplete

    // Page2: After upload completes and remoteKey is set, canDisplay should become true
    await expect(page2.locator('[data-testid="file-can-display"]')).toHaveText('true', {
      timeout: 10000,
    })

    // Page2: Image should now be visible
    await waitForImageLoaded(page2.locator('[data-testid="file-image"]'), 10000)

    await context1.close()
    await context2.close()
  })

  test('edited file should display immediately on originating client while uploading', async ({ browser }) => {
    const storeId = `test_${Date.now()}_${Math.random().toString(36).slice(2)}`
    const url = `/?storeId=${storeId}`

    const context1 = await browser.newContext()
    const context2 = await browser.newContext()

    const page1 = await context1.newPage()
    const page2 = await context2.newPage()

    await page1.goto(url)
    await page2.goto(url)

    await waitForLiveStore(page1)
    await waitForLiveStore(page2)

    // First, upload a file normally (no delay)
    const testImage = createTestImage('red')
    await page1.locator('input[type="file"]').setInputFiles(testImage)

    await expect(page1.locator('[data-testid="file-card"]')).toHaveCount(1, { timeout: 10000 })
    await waitForImageLoaded(page1.locator('[data-testid="file-image"]'), 10000)

    await expect(page2.locator('[data-testid="file-card"]')).toHaveCount(1, { timeout: 15000 })
    await waitForImageLoaded(page2.locator('[data-testid="file-image"]'), 15000)

    // Now set up delay for the edit upload
    let editUploadResolve: (() => void) | null = null
    const editUploadComplete = new Promise<void>((resolve) => {
      editUploadResolve = resolve
    })

    await page1.route('**/livestore-filesync-files/**', async (route) => {
      if (route.request().method() === 'PUT') {
        await new Promise((resolve) => setTimeout(resolve, 3000))
        editUploadResolve?.()
      }
      await route.continue()
    })

    // Record initial src on both pages
    const page1InitialSrc = await page1.locator('[data-testid="file-image"]').getAttribute('src')
    const page2InitialSrc = await page2.locator('[data-testid="file-image"]').getAttribute('src')

    // Click edit on page1
    await page1.locator('[data-testid="edit-button"]').click()

    // Page1: src should change immediately (new path from edit)
    await expect
      .poll(async () => page1.locator('[data-testid="file-image"]').getAttribute('src'), { timeout: 5000 })
      .not.toBe(page1InitialSrc)

    // Page1: canDisplay should still be true (has local copy of edited file)
    await expect(page1.locator('[data-testid="file-can-display"]')).toHaveText('true')

    // Page1: edited image should be visible immediately
    await waitForImageLoaded(page1.locator('[data-testid="file-image"]'), 5000)

    // Page2: should see placeholder while upload is pending
    // The file metadata syncs immediately but remoteKey is empty
    await expect(page2.locator('[data-testid="file-can-display"]')).toHaveText('false', {
      timeout: 5000,
    })
    await expect(page2.locator('[data-testid="file-placeholder"]')).toBeVisible()

    // Wait for edit upload to complete
    await editUploadComplete

    // Page2: After upload completes, canDisplay should become true
    await expect(page2.locator('[data-testid="file-can-display"]')).toHaveText('true', {
      timeout: 10000,
    })

    // Page2: Image should now be visible with updated src
    await expect
      .poll(async () => page2.locator('[data-testid="file-image"]').getAttribute('src'), { timeout: 5000 })
      .not.toBe(page2InitialSrc)

    await waitForImageLoaded(page2.locator('[data-testid="file-image"]'), 10000)

    await context1.close()
    await context2.close()
  })
})
