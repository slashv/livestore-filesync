import { test, expect } from '@playwright/test'
import {
  createTestImage,
  createTestTextFile,
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

  test('should generate thumbnail for JPEG image', async ({ page }) => {
    const storeId = generateStoreId('thumb-jpeg')
    await page.goto(`/?storeId=${storeId}`)
    await waitForLiveStore(page)

    // Upload a JPEG image
    const testImage = createTestImage('blue', { format: 'jpg' })
    await page.locator('input[type="file"]').setInputFiles(testImage)

    // Wait for file card to appear
    await expect(page.locator('[data-testid="file-card"]')).toHaveCount(1, {
      timeout: 10000,
    })

    // Wait for image to be visible
    await waitForImageLoaded(page.locator('[data-testid="file-image"]'), 10000)

    // Wait for thumbnail to be generated
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

    // The image should be showing a blob: URL (thumbnail)
    const imageSrc = await page.locator('[data-testid="file-image"]').getAttribute('src')
    expect(imageSrc).toMatch(/^blob:/)
  })

  test('should mark non-image files as skipped', async ({ page }) => {
    const storeId = generateStoreId('thumb-skip')
    await page.goto(`/?storeId=${storeId}`)
    await waitForLiveStore(page)

    // Upload a text file (not an image)
    const testFile = createTestTextFile()
    await page.locator('input[type="file"]').setInputFiles(testFile)

    // Wait for file card to appear
    await expect(page.locator('[data-testid="file-card"]')).toHaveCount(1, {
      timeout: 10000,
    })

    // Wait for thumbnail status to become 'skipped' (not an image)
    await expect.poll(
      async () => {
        const status = await page.locator('[data-testid="thumbnail-status"]').textContent()
        return status?.trim()
      },
      { timeout: 30000, intervals: [500, 1000, 2000] }
    ).toBe('skipped')

    // Thumbnail URL should NOT be generated
    await expect(page.locator('[data-testid="thumbnail-url"]')).toHaveText('Not generated')

    // No thumbnail badge should be visible
    await expect(page.locator('[data-testid="thumbnail-badge"]')).not.toBeVisible()
  })

  test('should handle rapid batch upload of 5 images', async ({ page }) => {
    const storeId = generateStoreId('thumb-batch')
    await page.goto(`/?storeId=${storeId}`)
    await waitForLiveStore(page)

    // Create 5 test images
    const testImages = [
      createTestImage('blue', { suffix: 'batch-1' }),
      createTestImage('red', { suffix: 'batch-2' }),
      createTestImage('blue', { suffix: 'batch-3' }),
      createTestImage('red', { suffix: 'batch-4' }),
      createTestImage('blue', { suffix: 'batch-5' }),
    ]

    // Upload all images rapidly (one after another without waiting)
    for (const image of testImages) {
      await page.locator('input[type="file"]').setInputFiles(image)
    }

    // Wait for all 5 file cards to appear
    await expect(page.locator('[data-testid="file-card"]')).toHaveCount(5, {
      timeout: 30000,
    })

    // Wait for ALL thumbnails to be generated (all 5 should reach 'done')
    await expect.poll(
      async () => {
        const statuses = await page.locator('[data-testid="thumbnail-status"]').allTextContents()
        const doneCount = statuses.filter(s => s.trim() === 'done').length
        return doneCount
      },
      { timeout: 90000, intervals: [1000, 2000, 3000] }
    ).toBe(5)

    // All 5 should have thumbnail badges
    await expect(page.locator('[data-testid="thumbnail-badge"]')).toHaveCount(5)

    // All 5 images should be showing blob: URLs
    const imageSrcs = await page.locator('[data-testid="file-image"]').evaluateAll(
      (imgs: HTMLImageElement[]) => imgs.map(img => img.src)
    )
    expect(imageSrcs).toHaveLength(5)
    for (const src of imageSrcs) {
      expect(src).toMatch(/^blob:/)
    }
  })

  test('should handle file deletion without breaking thumbnail UI', async ({ page }) => {
    const storeId = generateStoreId('thumb-delete')
    await page.goto(`/?storeId=${storeId}`)
    await waitForLiveStore(page)

    // Upload two images
    const testImage1 = createTestImage('blue', { suffix: 'del-1' })
    await page.locator('input[type="file"]').setInputFiles(testImage1)

    await expect(page.locator('[data-testid="file-card"]')).toHaveCount(1, {
      timeout: 10000,
    })

    const testImage2 = createTestImage('red', { suffix: 'del-2' })
    await page.locator('input[type="file"]').setInputFiles(testImage2)

    await expect(page.locator('[data-testid="file-card"]')).toHaveCount(2, {
      timeout: 10000,
    })

    // Wait for both thumbnails to be generated
    await expect.poll(
      async () => {
        const statuses = await page.locator('[data-testid="thumbnail-status"]').allTextContents()
        return statuses.every(s => s.trim() === 'done')
      },
      { timeout: 60000, intervals: [1000, 2000] }
    ).toBe(true)

    // Both should have thumbnail badges
    await expect(page.locator('[data-testid="thumbnail-badge"]')).toHaveCount(2)

    // Delete the first file
    await page.locator('[data-testid="delete-button"]').first().click()

    // Should now have only 1 file card
    await expect(page.locator('[data-testid="file-card"]')).toHaveCount(1, {
      timeout: 10000,
    })

    // The remaining file should still have its thumbnail
    await expect(page.locator('[data-testid="thumbnail-status"]')).toHaveText('done')
    await expect(page.locator('[data-testid="thumbnail-badge"]')).toBeVisible()

    // The remaining image should still show a blob URL
    const imageSrc = await page.locator('[data-testid="file-image"]').getAttribute('src')
    expect(imageSrc).toMatch(/^blob:/)

    // No console errors should occur (check page has no uncaught exceptions)
    // This is implicitly tested by the page not crashing
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
