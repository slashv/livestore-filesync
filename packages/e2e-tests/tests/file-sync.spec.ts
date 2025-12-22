import { test, expect } from '@playwright/test'
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

async function waitForLiveStore(page: import('@playwright/test').Page) {
  await page.waitForFunction(
    () => !document.body.innerText.includes('Loading LiveStore'),
    { timeout: 60000 }
  )
  await page.waitForSelector('[data-testid="gallery"]', { timeout: 30000 })
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
  })
})
