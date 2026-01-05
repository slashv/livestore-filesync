import { test, expect } from '@playwright/test'
import {
  createTestImage,
  createMultipleTestImages,
  waitForLiveStore,
  waitForImageLoaded,
  getRemoteKey,
  toRemoteUrl,
  waitForRemoteStatus,
  generateStoreId,
} from './helpers'

test.describe('File Sync', () => {
  test('should add a file', async ({ page }) => {
    // Use a unique storeId for test isolation
    const storeId = generateStoreId()
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
    const storeId = generateStoreId()
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
    const storeId = generateStoreId()
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
    const storeId = generateStoreId()
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
    const storeId = generateStoreId()
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
    const storeId = generateStoreId()
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
    const storeId = generateStoreId()
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

  test('should handle single file upload in same-context tabs without errors', async ({ browser }) => {
    // Simpler test case: single file upload with two tabs open
    // This replicates the bug where even a single file causes errors
    // when another tab is open in the same browser context

    const storeId = generateStoreId()
    const url = `/?storeId=${storeId}`

    // Create a SINGLE browser context (shared SharedWorker between pages)
    const context = await browser.newContext()

    // Open two pages (tabs) in the SAME context
    const page1 = await context.newPage()
    const page2 = await context.newPage()

    // Set up error tracking on both pages
    const errors: string[] = []
    const consoleMessages: string[] = []

    const trackErrors = (page: typeof page1, label: string) => {
      page.on('pageerror', (error) => {
        errors.push(`[${label}] ${error.message}`)
      })
      page.on('console', (msg) => {
        const text = msg.text()
        if (
          text.includes('UNIQUE constraint') ||
          text.includes('UnknownError') ||
          text.includes('SqliteError') ||
          text.includes('ERROR')
        ) {
          consoleMessages.push(`[${label}] ${text}`)
        }
      })
    }

    trackErrors(page1, 'Tab1')
    trackErrors(page2, 'Tab2')

    // Navigate both tabs to the app with the same storeId
    await page1.goto(url)
    await page2.goto(url)

    await waitForLiveStore(page1)
    await waitForLiveStore(page2)

    // Verify both start with empty state
    await expect(page1.locator('[data-testid="empty-state"]')).toBeVisible()
    await expect(page2.locator('[data-testid="empty-state"]')).toBeVisible()

    // Upload a single file in Tab 1
    const testImage = createTestImage('blue')
    await page1.locator('input[type="file"]').setInputFiles(testImage)

    // Wait for file card to appear in Tab 1
    await expect(page1.locator('[data-testid="file-card"]')).toHaveCount(1, {
      timeout: 15000,
    })

    // Wait for image to load in Tab 1
    await waitForImageLoaded(page1.locator('[data-testid="file-image"]'), 10000)

    // Wait for file card to sync to Tab 2
    await expect(page2.locator('[data-testid="file-card"]')).toHaveCount(1, {
      timeout: 15000,
    })

    // Give some time for any async errors to surface
    await page1.waitForTimeout(2000)

    // Log all captured messages for debugging
    if (consoleMessages.length > 0) {
      console.log('Console messages with errors:', consoleMessages)
    }
    if (errors.length > 0) {
      console.log('Page errors:', errors)
    }

    // Check for any LiveStore/SQLite errors
    const criticalErrors = [
      ...errors,
      ...consoleMessages.filter(
        (m) =>
          m.includes('UNIQUE constraint') ||
          m.includes('SqliteError') ||
          m.includes('UnknownError')
      ),
    ]

    expect(criticalErrors).toHaveLength(0)

    await context.close()
  })

  test('should handle multiple file uploads in same-context tabs without errors', async ({ browser }) => {
    // This test replicates the bug where adding multiple files in one tab
    // while another tab is open in the same browser context causes
    // "UNIQUE constraint failed: files.id" errors.
    //
    // Same browser context = SharedWorker is shared between tabs
    // This is different from separate contexts which simulate different browsers/clients

    const storeId = generateStoreId()
    const url = `/?storeId=${storeId}`

    // Create a SINGLE browser context (shared SharedWorker between pages)
    const context = await browser.newContext()

    // Open two pages (tabs) in the SAME context
    const page1 = await context.newPage()
    const page2 = await context.newPage()

    // Set up error tracking on both pages
    const errors: string[] = []
    const consoleMessages: string[] = []

    const trackErrors = (page: typeof page1, label: string) => {
      page.on('pageerror', (error) => {
        errors.push(`[${label}] ${error.message}`)
      })
      page.on('console', (msg) => {
        const text = msg.text()
        if (
          text.includes('UNIQUE constraint') ||
          text.includes('UnknownError') ||
          text.includes('SqliteError') ||
          text.includes('ERROR')
        ) {
          consoleMessages.push(`[${label}] ${text}`)
        }
      })
    }

    trackErrors(page1, 'Tab1')
    trackErrors(page2, 'Tab2')

    // Navigate both tabs to the app with the same storeId
    await page1.goto(url)
    await page2.goto(url)

    await waitForLiveStore(page1)
    await waitForLiveStore(page2)

    // Verify both start with empty state
    await expect(page1.locator('[data-testid="empty-state"]')).toBeVisible()
    await expect(page2.locator('[data-testid="empty-state"]')).toBeVisible()

    // Create multiple test images (6+ to trigger the race condition)
    const testImages = createMultipleTestImages(8)

    // Upload all files at once in Tab 1
    await page1.locator('input[type="file"]').setInputFiles(testImages)

    // Wait for file cards to appear in Tab 1
    await expect(page1.locator('[data-testid="file-card"]')).toHaveCount(8, {
      timeout: 30000,
    })

    // Wait for all images to load in Tab 1
    const page1Images = page1.locator('[data-testid="file-image"]')
    for (let i = 0; i < 8; i++) {
      await waitForImageLoaded(page1Images.nth(i), 15000)
    }

    // Wait for file cards to sync to Tab 2
    await expect(page2.locator('[data-testid="file-card"]')).toHaveCount(8, {
      timeout: 30000,
    })

    // Give some time for any async errors to surface
    await page1.waitForTimeout(2000)

    // Log all captured messages for debugging
    if (consoleMessages.length > 0) {
      console.log('Console messages with errors:', consoleMessages)
    }
    if (errors.length > 0) {
      console.log('Page errors:', errors)
    }

    // Check for any LiveStore/SQLite errors
    const criticalErrors = [
      ...errors,
      ...consoleMessages.filter(
        (m) =>
          m.includes('UNIQUE constraint') ||
          m.includes('SqliteError') ||
          m.includes('UnknownError')
      ),
    ]

    expect(criticalErrors).toHaveLength(0)

    await context.close()
  })

  test('should sync 10 files across two browsers with two tabs each', async ({ browser }) => {
    // This test verifies syncing works correctly when:
    // - Browser 1 has two tabs (Tab A, Tab B) sharing the same SharedWorker
    // - Browser 2 has two tabs (Tab C, Tab D) sharing the same SharedWorker
    // - 10 files uploaded in one tab should sync to all 4 tabs
    //
    // KNOWN ISSUE: Opening multiple browser contexts simultaneously can trigger
    // a LiveStore WASM SQLite bug: "function signature mismatch" during
    // changeset_apply/rollback in client-session-sync-processor:pull.
    // This occurs when a new client pulls existing changesets while another
    // client is actively making changes. We work around this by staggering
    // the tab navigation to allow each context to stabilize before opening the next.
    // See: https://github.com/livestorejs/livestore - needs minimal repro

    const storeId = generateStoreId()
    const url = `/?storeId=${storeId}`
    const fileCount = 10

    // Create two separate browser contexts (simulates two different browsers/users)
    const context1 = await browser.newContext()
    const context2 = await browser.newContext()

    // Create two tabs in each browser context
    const browser1TabA = await context1.newPage()
    const browser1TabB = await context1.newPage()
    const browser2TabC = await context2.newPage()
    const browser2TabD = await context2.newPage()

    const allTabs = [browser1TabA, browser1TabB, browser2TabC, browser2TabD]
    const tabNames = ['Browser1-TabA', 'Browser1-TabB', 'Browser2-TabC', 'Browser2-TabD']

    // Set up error tracking on all tabs
    const errors: string[] = []
    const consoleMessages: string[] = []

    const trackErrors = (page: typeof browser1TabA, label: string) => {
      page.on('pageerror', (error) => {
        errors.push(`[${label}] ${error.message}`)
      })
      page.on('console', (msg) => {
        const text = msg.text()
        if (
          text.includes('UNIQUE constraint') ||
          text.includes('UnknownError') ||
          text.includes('SqliteError') ||
          text.includes('ERROR')
        ) {
          consoleMessages.push(`[${label}] ${text}`)
        }
      })
    }

    allTabs.forEach((tab, i) => trackErrors(tab, tabNames[i]))

    // Navigate tabs sequentially with stabilization delays between browser contexts
    // to avoid LiveStore WASM changeset race condition (see comment above)
    await browser1TabA.goto(url)
    await waitForLiveStore(browser1TabA)

    await browser1TabB.goto(url)
    await waitForLiveStore(browser1TabB)

    // Allow Browser 1 context to fully stabilize before opening Browser 2
    await browser1TabA.waitForTimeout(1000)

    await browser2TabC.goto(url)
    await waitForLiveStore(browser2TabC)

    await browser2TabD.goto(url)
    await waitForLiveStore(browser2TabD)

    // Verify all tabs start with empty state
    await Promise.all(
      allTabs.map((tab) =>
        expect(tab.locator('[data-testid="empty-state"]')).toBeVisible()
      )
    )

    // Upload 10 files in Browser 1, Tab A
    const testImages = createMultipleTestImages(fileCount)
    await browser1TabA.locator('input[type="file"]').setInputFiles(testImages)

    // Wait for all file cards to appear in the originating tab
    await expect(browser1TabA.locator('[data-testid="file-card"]')).toHaveCount(fileCount, {
      timeout: 30000,
    })

    // Wait for all images to load in the originating tab
    const originatingImages = browser1TabA.locator('[data-testid="file-image"]')
    for (let i = 0; i < fileCount; i++) {
      await waitForImageLoaded(originatingImages.nth(i), 20000)
    }
    console.log(`✓ Browser1-TabA: All ${fileCount} files uploaded and displayed`)

    // Wait for all files to sync to all other tabs
    for (let tabIndex = 1; tabIndex < allTabs.length; tabIndex++) {
      const tab = allTabs[tabIndex]
      const tabName = tabNames[tabIndex]

      // Wait for all file cards to appear
      await expect(tab.locator('[data-testid="file-card"]')).toHaveCount(fileCount, {
        timeout: 30000,
      })

      // Wait for all canDisplay to become true (files are available)
      const canDisplayLocators = tab.locator('[data-testid="file-can-display"]')
      await expect(canDisplayLocators).toHaveCount(fileCount, { timeout: 10000 })
      
      // Poll until all files can be displayed
      await expect
        .poll(
          async () => {
            const texts = await canDisplayLocators.allTextContents()
            return texts.every((text) => text === 'true')
          },
          { timeout: 30000, intervals: [500] }
        )
        .toBe(true)

      // Wait for all images to load (Firefox can be slower with blob URLs)
      const tabImages = tab.locator('[data-testid="file-image"]')
      for (let i = 0; i < fileCount; i++) {
        await waitForImageLoaded(tabImages.nth(i), 20000)
      }

      console.log(`✓ ${tabName}: All ${fileCount} files synced and displayed`)
    }

    // Give some time for any async errors to surface
    await browser1TabA.waitForTimeout(2000)

    // Log all captured messages for debugging
    if (consoleMessages.length > 0) {
      console.log('Console messages with errors:', consoleMessages)
    }
    if (errors.length > 0) {
      console.log('Page errors:', errors)
    }

    // Check for any critical errors
    const criticalErrors = [
      ...errors,
      ...consoleMessages.filter(
        (m) =>
          m.includes('UNIQUE constraint') ||
          m.includes('SqliteError') ||
          m.includes('UnknownError')
      ),
    ]

    expect(criticalErrors).toHaveLength(0)

    // Cleanup
    await context1.close()
    await context2.close()
  })
})
