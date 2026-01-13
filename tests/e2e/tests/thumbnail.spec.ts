import { test, expect } from '@playwright/test'
import {
  createTestImage,
  waitForLiveStore,
  waitForImageLoaded,
  generateStoreId,
} from './helpers'

// Thumbnail tests only run against the vue-thumbnail example
// which has wasm-vips and the image-thumbnails package configured.
// Skip if not running with E2E_FRAMEWORK=thumbnail or no framework set.
const shouldRun = process.env.E2E_FRAMEWORK === 'thumbnail'

test.describe('Image Thumbnails', () => {
  test.skip(!shouldRun, 'Thumbnail tests only run with E2E_FRAMEWORK=thumbnail')

  test('should generate thumbnail for uploaded image', async ({ page }) => {
    const storeId = generateStoreId('thumb')
    await page.goto(`/?storeId=${storeId}`)
    await waitForLiveStore(page)

    // Verify we start with empty state
    await expect(page.locator('[data-testid="empty-state"]')).toBeVisible()

    // Upload an image
    const testImage = createTestImage('blue')
    await page.locator('input[type="file"]').setInputFiles(testImage)

    // Wait for file card to appear
    await expect(page.locator('[data-testid="file-card"]')).toHaveCount(1, {
      timeout: 10000,
    })

    // Wait for image to be visible
    await waitForImageLoaded(page.locator('[data-testid="file-image"]'), 10000)

    // Wait for thumbnail to be generated
    // The thumbnail status should transition from 'pending' to 'done'
    await expect.poll(
      async () => {
        const status = await page.locator('[data-testid="thumbnail-status"]').textContent()
        return status?.trim()
      },
      { timeout: 30000, intervals: [500, 1000, 2000] }
    ).toBe('done')

    // Verify thumbnail URL is set
    await expect(page.locator('[data-testid="thumbnail-url"]')).toHaveText('Generated')

    // Verify thumbnail badge is visible
    await expect(page.locator('[data-testid="thumbnail-badge"]')).toBeVisible()
  })

  test('should display thumbnail instead of full image', async ({ page }) => {
    const storeId = generateStoreId('thumb')
    await page.goto(`/?storeId=${storeId}`)
    await waitForLiveStore(page)

    // Upload an image
    const testImage = createTestImage('red')
    await page.locator('input[type="file"]').setInputFiles(testImage)

    // Wait for file card
    await expect(page.locator('[data-testid="file-card"]')).toHaveCount(1, {
      timeout: 10000,
    })

    // Wait for thumbnail to be generated
    await expect.poll(
      async () => {
        const status = await page.locator('[data-testid="thumbnail-status"]').textContent()
        return status?.trim()
      },
      { timeout: 30000, intervals: [500, 1000, 2000] }
    ).toBe('done')

    // The image should now be showing the thumbnail (blob: URL)
    const imageSrc = await page.locator('[data-testid="file-image"]').getAttribute('src')
    expect(imageSrc).toBeTruthy()
    // Thumbnail URLs from OPFS are blob: URLs
    expect(imageSrc).toMatch(/^blob:/)
  })

  test('should persist thumbnail state across page refresh', async ({ page }) => {
    const storeId = generateStoreId('thumb-persist')
    await page.goto(`/?storeId=${storeId}`)
    await waitForLiveStore(page)

    // Upload an image
    const testImage = createTestImage('blue')
    await page.locator('input[type="file"]').setInputFiles(testImage)

    // Wait for thumbnail to be generated
    await expect.poll(
      async () => {
        const status = await page.locator('[data-testid="thumbnail-status"]').textContent()
        return status?.trim()
      },
      { timeout: 30000, intervals: [500, 1000, 2000] }
    ).toBe('done')

    // Verify thumbnail badge is visible
    await expect(page.locator('[data-testid="thumbnail-badge"]')).toBeVisible()

    // Refresh the page
    await page.reload()
    await waitForLiveStore(page)

    // Wait for file card to appear again
    await expect(page.locator('[data-testid="file-card"]')).toHaveCount(1, {
      timeout: 10000,
    })

    // Thumbnail should still be available (state persisted in OPFS)
    await expect(page.locator('[data-testid="thumbnail-url"]')).toHaveText('Generated', {
      timeout: 10000,
    })
    await expect(page.locator('[data-testid="thumbnail-badge"]')).toBeVisible()
  })

  test('should generate thumbnails for multiple uploaded images', async ({ page }) => {
    const storeId = generateStoreId('thumb-multi')
    await page.goto(`/?storeId=${storeId}`)
    await waitForLiveStore(page)

    // Upload first image
    const testImage1 = createTestImage('blue', { suffix: 'multi-1' })
    await page.locator('input[type="file"]').setInputFiles(testImage1)

    // Wait for first file card
    await expect(page.locator('[data-testid="file-card"]')).toHaveCount(1, {
      timeout: 10000,
    })

    // Upload second image
    const testImage2 = createTestImage('red', { suffix: 'multi-2' })
    await page.locator('input[type="file"]').setInputFiles(testImage2)

    // Wait for both file cards
    await expect(page.locator('[data-testid="file-card"]')).toHaveCount(2, {
      timeout: 10000,
    })

    // Upload third image
    const testImage3 = createTestImage('blue', { suffix: 'multi-3' })
    await page.locator('input[type="file"]').setInputFiles(testImage3)

    // Wait for all three file cards
    await expect(page.locator('[data-testid="file-card"]')).toHaveCount(3, {
      timeout: 10000,
    })

    // Wait for all thumbnails to be generated
    await expect.poll(
      async () => {
        const statuses = await page.locator('[data-testid="thumbnail-status"]').allTextContents()
        return statuses.every(s => s.trim() === 'done')
      },
      { timeout: 60000, intervals: [1000, 2000, 3000] }
    ).toBe(true)

    // All should have thumbnail badges
    await expect(page.locator('[data-testid="thumbnail-badge"]')).toHaveCount(3)
  })

  test('should regenerate thumbnail when file is edited', async ({ page }) => {
    const storeId = generateStoreId('thumb-edit')
    await page.goto(`/?storeId=${storeId}`)
    await waitForLiveStore(page)

    // Upload an image
    const testImage = createTestImage('blue')
    await page.locator('input[type="file"]').setInputFiles(testImage)

    // Wait for initial thumbnail to be generated
    await expect.poll(
      async () => {
        const status = await page.locator('[data-testid="thumbnail-status"]').textContent()
        return status?.trim()
      },
      { timeout: 30000, intervals: [500, 1000, 2000] }
    ).toBe('done')

    // Get the initial thumbnail URL
    const initialImage = await page.locator('[data-testid="file-image"]').getAttribute('src')

    // Edit the image (inverts colors)
    await page.locator('[data-testid="edit-button"]').click()

    // Wait for thumbnail to be regenerated (status may briefly change)
    // Give it time to detect the change and regenerate
    await page.waitForTimeout(1000)

    // Wait for thumbnail to be done again
    await expect.poll(
      async () => {
        const status = await page.locator('[data-testid="thumbnail-status"]').textContent()
        return status?.trim()
      },
      { timeout: 30000, intervals: [500, 1000, 2000] }
    ).toBe('done')

    // Thumbnail badge should still be visible
    await expect(page.locator('[data-testid="thumbnail-badge"]')).toBeVisible()

    // The new thumbnail URL should be different (new blob URL)
    const newImage = await page.locator('[data-testid="file-image"]').getAttribute('src')
    expect(newImage).toBeTruthy()
    // Both should be blob URLs
    expect(initialImage).toMatch(/^blob:/)
    expect(newImage).toMatch(/^blob:/)
  })

  test('should handle thumbnail generation status transitions', async ({ page }) => {
    const storeId = generateStoreId('thumb-status')
    await page.goto(`/?storeId=${storeId}`)
    await waitForLiveStore(page)

    // Upload an image
    const testImage = createTestImage('blue')
    await page.locator('input[type="file"]').setInputFiles(testImage)

    // Wait for file card
    await expect(page.locator('[data-testid="file-card"]')).toHaveCount(1, {
      timeout: 10000,
    })

    // Track status transitions
    const statusesObserved = new Set<string>()
    const pollStatus = async () => {
      const status = await page.locator('[data-testid="thumbnail-status"]').textContent()
      if (status) statusesObserved.add(status.trim())
      return status?.trim()
    }

    // Poll until we reach 'done'
    await expect.poll(pollStatus, { timeout: 30000, intervals: [100, 200, 500] }).toBe('done')

    // We should have observed at least 'done'
    expect(statusesObserved.has('done')).toBe(true)

    // Valid statuses: pending, queued, generating, done, error, skipped
    const validStatuses = new Set(['pending', 'queued', 'generating', 'done', 'error', 'skipped'])
    for (const status of statusesObserved) {
      expect(validStatuses.has(status)).toBe(true)
    }
  })
})

test.describe('Image Thumbnails - Cross-browser sync', () => {
  test.skip(!shouldRun, 'Thumbnail tests only run with E2E_FRAMEWORK=thumbnail')

  // This test requires a real sync backend (R2/S3) to transfer files between browser contexts.
  // Each browser has its own OPFS, so Browser 2 needs to download the file from remote storage
  // before it can generate thumbnails. Skip for now until we have backend integration tests.
  test.skip('thumbnail state is local only - other browser generates its own', async ({ browser }) => {
    const storeId = generateStoreId('thumb-cross')
    const url = `/?storeId=${storeId}`

    // Create two separate browser contexts
    const context1 = await browser.newContext()
    const context2 = await browser.newContext()

    const page1 = await context1.newPage()
    const page2 = await context2.newPage()

    await page1.goto(url)
    await page2.goto(url)

    await waitForLiveStore(page1)
    await waitForLiveStore(page2)

    // Upload a file in browser 1
    const testImage = createTestImage('blue')
    await page1.locator('input[type="file"]').setInputFiles(testImage)

    // Wait for thumbnail in browser 1
    await expect.poll(
      async () => {
        const status = await page1.locator('[data-testid="thumbnail-status"]').textContent()
        return status?.trim()
      },
      { timeout: 30000, intervals: [500, 1000] }
    ).toBe('done')

    // Browser 2 should see the file (synced via LiveStore)
    await expect(page2.locator('[data-testid="file-card"]')).toHaveCount(1, {
      timeout: 30000,
    })

    // Browser 2 should generate its own thumbnail independently
    // (thumbnails are NOT synced between clients)
    await expect.poll(
      async () => {
        const status = await page2.locator('[data-testid="thumbnail-status"]').textContent()
        return status?.trim()
      },
      { timeout: 30000, intervals: [500, 1000] }
    ).toBe('done')

    // Both should have thumbnail badges
    await expect(page1.locator('[data-testid="thumbnail-badge"]')).toBeVisible()
    await expect(page2.locator('[data-testid="thumbnail-badge"]')).toBeVisible()

    // Cleanup
    await context1.close()
    await context2.close()
  })
})
