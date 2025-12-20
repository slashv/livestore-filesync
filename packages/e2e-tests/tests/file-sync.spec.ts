import { test, expect, selectors } from './fixtures'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

test.describe('File Sync Gallery', () => {
  test.beforeEach(async ({ galleryPage }) => {
    await galleryPage.goto()
  })

  test.describe('Initial State', () => {
    test('should display the gallery container', async ({ page }) => {
      await expect(page.locator(selectors.gallery)).toBeVisible()
    })

    test('should show upload button', async ({ page }) => {
      await expect(page.locator(selectors.uploadButton)).toBeVisible()
    })

    test('should show online status indicator', async ({ galleryPage }) => {
      const isOnline = await galleryPage.isOnline()
      expect(isOnline).toBe(true)
    })
  })

  test.describe('File Upload', () => {
    test('should upload a file successfully', async ({ galleryPage }) => {
      const initialCount = await galleryPage.getFileCount()

      await galleryPage.uploadTestImage('upload-test.png')

      // Wait for file to appear
      await expect(async () => {
        const count = await galleryPage.getFileCount()
        expect(count).toBe(initialCount + 1)
      }).toPass({ timeout: 10000 })
    })

    test('should display file card after upload', async ({ galleryPage, page }) => {
      const initialCount = await galleryPage.getFileCount()
      await galleryPage.uploadTestImage('named-file.png')

      // File card should appear (content-addressable storage uses hash as ID)
      await expect(async () => {
        const count = await galleryPage.getFileCount()
        expect(count).toBe(initialCount + 1)
      }).toPass({ timeout: 10000 })

      // File card should have an image or placeholder
      const cards = await galleryPage.getFileCards()
      expect(cards.length).toBeGreaterThan(0)
    })

    test('should show upload status indicator', async ({ galleryPage, page }) => {
      const initialCount = await galleryPage.getFileCount()
      await galleryPage.uploadTestImage('status-test.png')

      // Wait for file to appear
      await expect(async () => {
        const count = await galleryPage.getFileCount()
        expect(count).toBe(initialCount + 1)
      }).toPass({ timeout: 10000 })

      // Should show some status on the new card
      const statusBadge = page.locator(selectors.fileStatus).first()
      await expect(statusBadge).toBeVisible({ timeout: 5000 })
    })

    test('should eventually show synced status', async ({ galleryPage, page }) => {
      const initialCount = await galleryPage.getFileCount()
      await galleryPage.uploadTestImage('sync-test.png')

      // Wait for file to appear
      await expect(async () => {
        const count = await galleryPage.getFileCount()
        expect(count).toBe(initialCount + 1)
      }).toPass({ timeout: 10000 })

      // Wait for sync to complete (check any status badge shows "Synced")
      await expect(page.locator(selectors.fileStatus).first()).toContainText('Synced', {
        timeout: 15000
      })
    })
  })

  test.describe('File Display', () => {
    test('should display file thumbnail/preview', async ({ galleryPage, page }) => {
      await galleryPage.uploadTestImage('preview-test.png')

      // Wait for file card to appear
      const card = await galleryPage.getFileCardByName('preview-test.png')
      await expect(card).toBeVisible({ timeout: 10000 })

      // Should have an image element
      const image = card.locator('img')
      await expect(image).toBeVisible({ timeout: 10000 })
    })

    test('should display multiple files', async ({ galleryPage }) => {
      await galleryPage.uploadTestImage('multi-1.png')
      await galleryPage.uploadTestImage('multi-2.png')
      await galleryPage.uploadTestImage('multi-3.png')

      await expect(async () => {
        const count = await galleryPage.getFileCount()
        expect(count).toBeGreaterThanOrEqual(3)
      }).toPass({ timeout: 15000 })
    })
  })

  test.describe('File Deletion', () => {
    test('should delete a file', async ({ galleryPage }) => {
      await galleryPage.uploadTestImage('delete-test.png')

      // Wait for file to appear
      await expect(async () => {
        const count = await galleryPage.getFileCount()
        expect(count).toBeGreaterThan(0)
      }).toPass({ timeout: 10000 })

      const initialCount = await galleryPage.getFileCount()

      // Delete the file
      await galleryPage.deleteFile('delete-test.png')

      // File count should decrease
      await expect(async () => {
        const count = await galleryPage.getFileCount()
        expect(count).toBe(initialCount - 1)
      }).toPass({ timeout: 10000 })
    })

    test('should remove file card from UI after deletion', async ({ galleryPage, page }) => {
      await galleryPage.uploadTestImage('remove-test.png')

      // Wait for file to appear
      const card = await galleryPage.getFileCardByName('remove-test.png')
      await expect(card).toBeVisible({ timeout: 10000 })

      // Delete and verify removal
      await galleryPage.deleteFile('remove-test.png')

      await expect(card).not.toBeVisible({ timeout: 10000 })
    })
  })

  test.describe('Sync Status', () => {
    test('should transition through upload states', async ({ galleryPage }) => {
      await galleryPage.uploadTestImage('transition-test.png')

      // Should eventually reach synced state
      await galleryPage.waitForFileStatus('transition-test.png', 'Synced', 15000)
    })

    test('should show different statuses for different files', async ({ galleryPage }) => {
      // Upload multiple files quickly
      const uploadPromise1 = galleryPage.uploadTestImage('batch-1.png')
      const uploadPromise2 = galleryPage.uploadTestImage('batch-2.png')

      await Promise.all([uploadPromise1, uploadPromise2])

      // Both should eventually sync
      await galleryPage.waitForFileStatus('batch-1.png', 'Synced', 20000)
      await galleryPage.waitForFileStatus('batch-2.png', 'Synced', 20000)
    })
  })
})

test.describe('Cross-Tab Sync', () => {
  test('should sync files across browser tabs', async ({ browser }) => {
    // Open two tabs
    const context = await browser.newContext()
    const page1 = await context.newPage()
    const page2 = await context.newPage()

    // Navigate both to the app
    await page1.goto('/')
    await page2.goto('/')

    // Wait for LiveStore to load on both pages
    await page1.waitForFunction(() => !document.body.innerText.includes('Loading LiveStore'), { timeout: 60000 })
    await page2.waitForFunction(() => !document.body.innerText.includes('Loading LiveStore'), { timeout: 60000 })

    // Wait for both to load
    await page1.waitForSelector(selectors.gallery, { timeout: 30000 })
    await page2.waitForSelector(selectors.gallery, { timeout: 30000 })

    // Upload a file in tab 1
    const fileInput = page1.locator(selectors.fileInput)
    const testImagePath = path.join(__dirname, '../fixtures/cross-tab-test.png')

    // Create test image if needed
    const fixturesDir = path.join(__dirname, '../fixtures')
    if (!fs.existsSync(fixturesDir)) {
      fs.mkdirSync(fixturesDir, { recursive: true })
    }
    if (!fs.existsSync(testImagePath)) {
      const pngData = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
        0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
        0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
        0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xfe,
        0xd4, 0xef, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
        0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
      ])
      fs.writeFileSync(testImagePath, pngData)
    }

    await fileInput.setInputFiles(testImagePath)

    // Wait for file to appear in tab 1
    await expect(page1.locator(selectors.fileCard)).toContainText('cross-tab-test.png', {
      timeout: 10000
    })

    // File should also appear in tab 2 (synced via SharedWorker/OPFS)
    await expect(page2.locator(selectors.fileCard)).toContainText('cross-tab-test.png', {
      timeout: 15000
    })

    await context.close()
  })
})

test.describe('Offline Support', () => {
  test('should indicate offline status when network is unavailable', async ({ page, context }) => {
    await page.goto('/')
    await page.waitForFunction(() => !document.body.innerText.includes('Loading LiveStore'), { timeout: 60000 })
    await page.waitForSelector(selectors.gallery, { timeout: 30000 })

    // Go offline
    await context.setOffline(true)

    // Wait a moment for the app to detect offline state
    await page.waitForTimeout(2000)

    // Check offline indication (implementation-specific)
    const statusIndicator = page.locator(selectors.statusIndicator)
    const isOfflineIndicator = page.locator(selectors.offlineStatus)

    const hasOfflineIndicator = await isOfflineIndicator.isVisible().catch(() => false)
    const indicatorText = await statusIndicator.textContent().catch(() => '')

    // Either dedicated offline element or text indicator
    const isOffline = hasOfflineIndicator || indicatorText?.toLowerCase().includes('offline')

    expect(isOffline).toBe(true)

    // Go back online
    await context.setOffline(false)
  })

  test('should allow file uploads while offline (queued)', async ({ page, context }) => {
    await page.goto('/')
    await page.waitForFunction(() => !document.body.innerText.includes('Loading LiveStore'), { timeout: 60000 })
    await page.waitForSelector(selectors.gallery, { timeout: 30000 })

    // Go offline
    await context.setOffline(true)
    await page.waitForTimeout(1000)

    // Try to upload - should be queued locally
    const fileInput = page.locator(selectors.fileInput)
    const testImagePath = path.join(__dirname, '../fixtures/offline-test.png')

    // Create test image
    const fixturesDir = path.join(__dirname, '../fixtures')
    if (!fs.existsSync(fixturesDir)) {
      fs.mkdirSync(fixturesDir, { recursive: true })
    }
    if (!fs.existsSync(testImagePath)) {
      const pngData = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
        0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
        0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
        0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xfe,
        0xd4, 0xef, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
        0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
      ])
      fs.writeFileSync(testImagePath, pngData)
    }

    await fileInput.setInputFiles(testImagePath)

    // File should still appear locally (stored in OPFS)
    await expect(page.locator(selectors.fileCard)).toContainText('offline-test.png', {
      timeout: 10000
    })

    // Go back online
    await context.setOffline(false)
  })

  test('should sync queued files when coming back online', async ({ page, context }) => {
    await page.goto('/')
    await page.waitForFunction(() => !document.body.innerText.includes('Loading LiveStore'), { timeout: 60000 })
    await page.waitForSelector(selectors.gallery, { timeout: 30000 })

    // Go offline
    await context.setOffline(true)
    await page.waitForTimeout(1000)

    // Upload while offline
    const fileInput = page.locator(selectors.fileInput)
    const testImagePath = path.join(__dirname, '../fixtures/resync-test.png')

    const fixturesDir = path.join(__dirname, '../fixtures')
    if (!fs.existsSync(fixturesDir)) {
      fs.mkdirSync(fixturesDir, { recursive: true })
    }
    if (!fs.existsSync(testImagePath)) {
      const pngData = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
        0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
        0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
        0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xfe,
        0xd4, 0xef, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
        0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
      ])
      fs.writeFileSync(testImagePath, pngData)
    }

    await fileInput.setInputFiles(testImagePath)

    // File should appear
    await expect(page.locator(selectors.fileCard)).toContainText('resync-test.png', {
      timeout: 10000
    })

    // Go back online
    await context.setOffline(false)

    // Should eventually sync
    await expect(async () => {
      const card = page.locator(selectors.fileCard).filter({
        has: page.locator('text="resync-test.png"')
      })
      const status = card.locator(selectors.fileStatus)
      const statusText = await status.textContent()
      expect(statusText).toContain('Synced')
    }).toPass({ timeout: 20000 })
  })
})

test.describe('Error Handling', () => {
  test('should handle failed uploads gracefully', async ({ page, context }) => {
    await page.goto('/')
    await page.waitForFunction(() => !document.body.innerText.includes('Loading LiveStore'), { timeout: 60000 })
    await page.waitForSelector(selectors.gallery, { timeout: 30000 })

    // Intercept upload requests and make them fail
    await page.route('**/upload**', route => route.abort())
    await page.route('**/files**', route => {
      if (route.request().method() === 'POST') {
        route.abort()
      } else {
        route.continue()
      }
    })

    // Try to upload
    const fileInput = page.locator(selectors.fileInput)
    const testImagePath = path.join(__dirname, '../fixtures/error-test.png')

    const fixturesDir = path.join(__dirname, '../fixtures')
    if (!fs.existsSync(fixturesDir)) {
      fs.mkdirSync(fixturesDir, { recursive: true })
    }
    if (!fs.existsSync(testImagePath)) {
      const pngData = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
        0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
        0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
        0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xfe,
        0xd4, 0xef, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
        0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
      ])
      fs.writeFileSync(testImagePath, pngData)
    }

    await fileInput.setInputFiles(testImagePath)

    // File should still appear locally (offline-first)
    await expect(page.locator(selectors.fileCard)).toContainText('error-test.png', {
      timeout: 10000
    })

    // App should not crash - gallery should still be visible
    await expect(page.locator(selectors.gallery)).toBeVisible()
  })
})

test.describe('Persistence', () => {
  test('should persist files across page reloads', async ({ page }) => {
    await page.goto('/')
    await page.waitForFunction(() => !document.body.innerText.includes('Loading LiveStore'), { timeout: 60000 })
    await page.waitForSelector(selectors.gallery, { timeout: 30000 })

    // Upload a file
    const fileInput = page.locator(selectors.fileInput)
    const testImagePath = path.join(__dirname, '../fixtures/persist-test.png')

    const fixturesDir = path.join(__dirname, '../fixtures')
    if (!fs.existsSync(fixturesDir)) {
      fs.mkdirSync(fixturesDir, { recursive: true })
    }
    if (!fs.existsSync(testImagePath)) {
      const pngData = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
        0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
        0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
        0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xfe,
        0xd4, 0xef, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
        0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
      ])
      fs.writeFileSync(testImagePath, pngData)
    }

    await fileInput.setInputFiles(testImagePath)

    // Wait for file to appear
    await expect(page.locator(selectors.fileCard)).toContainText('persist-test.png', {
      timeout: 10000
    })

    // Reload the page
    await page.reload()
    await page.waitForFunction(() => !document.body.innerText.includes('Loading LiveStore'), { timeout: 60000 })
    await page.waitForSelector(selectors.gallery, { timeout: 30000 })

    // File should still be there
    await expect(page.locator(selectors.fileCard)).toContainText('persist-test.png', {
      timeout: 10000
    })
  })
})
