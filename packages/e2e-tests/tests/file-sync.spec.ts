import { test, expect, type Page, type Locator } from '@playwright/test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// Create a test PNG file in temp directory
function createTestImage(): string {
  const imagePath = path.join(os.tmpdir(), `test-${Date.now()}.png`)

  // Minimal valid 1x1 PNG
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
  fs.writeFileSync(imagePath, pngData)

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

test.describe('File Sync', () => {
  test('should add a file', async ({ page }) => {
    // Use a unique storeId for test isolation
    const storeId = `test_${Date.now()}_${Math.random().toString(36).slice(2)}`
    await page.goto(`/?storeId=${storeId}`)
    await waitForLiveStore(page)

    // Verify we start with empty state
    await expect(page.locator('[data-testid="empty-state"]')).toBeVisible()

    // Upload a file
    const testImage = createTestImage()
    await page.locator('input[type="file"]').setInputFiles(testImage)

    // Wait for file card to appear
    await expect(page.locator('[data-testid="file-card"]')).toHaveCount(1, {
      timeout: 10000,
    })
    await waitForImageLoaded(page.locator('[data-testid="file-image"]'), 10000)
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
    const testImage = createTestImage()
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

    const testImage = createTestImage()
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
})
