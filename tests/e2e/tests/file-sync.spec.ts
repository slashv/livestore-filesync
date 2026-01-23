import { test, expect } from '@playwright/test'
import {
  createTestImage,
  createMultipleTestImages,
  waitForLiveStore,
  waitForLiveStoreAndSync,
  waitForImageLoaded,
  getRemoteKey,
  toRemoteUrl,
  waitForRemoteStatus,
  generateStoreId,
  setOffline,
  setOnline,
} from './helpers'

// React example has a known flakiness issue with multi-tab tests due to
// LiveStore's new StoreProvider format having timing issues with SharedWorker
// context sharing. Skip these tests for React until the upstream issue is resolved.
const isReact = process.env.E2E_FRAMEWORK === 'react'

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

  test('should trigger download on receiving client when file is synced', async ({ browser }) => {
    // This test verifies that when Browser A uploads a file:
    // 1. Browser B receives the file metadata via LiveStore sync
    // 2. Browser B displays the image (using remote URL) 
    // 3. Browser B triggers a download to sync the file locally
    // 4. Browser B's downloadStatus transitions to "done" and localHash gets set
    //
    // BUG: Currently, step 3 and 4 don't happen - the download is never triggered
    
    const storeId = generateStoreId()
    const url = `/?storeId=${storeId}`

    // Create two separate browser contexts (simulates two different clients)
    const context1 = await browser.newContext()
    const context2 = await browser.newContext()

    const page1 = await context1.newPage()
    const page2 = await context2.newPage()

    // Navigate both to the app with the same storeId
    await page1.goto(url)
    await page2.goto(url)

    await waitForLiveStoreAndSync(page1)
    await waitForLiveStoreAndSync(page2)

    // Verify both start with empty state
    await expect(page1.locator('[data-testid="empty-state"]')).toBeVisible()
    await expect(page2.locator('[data-testid="empty-state"]')).toBeVisible()

    // Upload a file in Browser 1
    const testImage = createTestImage('blue')
    await page1.locator('input[type="file"]').setInputFiles(testImage)

    // Wait for upload to complete in Browser 1
    await expect(page1.locator('[data-testid="file-card"]')).toHaveCount(1, { timeout: 10000 })
    await expect(page1.locator('[data-testid="file-upload-status"]')).toHaveText('done', { timeout: 15000 })
    
    // Get the content hash from Browser 1 for later comparison
    const contentHash = await page1.locator('[data-testid="file-card"] table').evaluate((table) => {
      const rows = table.querySelectorAll('tr')
      for (const row of rows) {
        const label = row.querySelector('td.label')?.textContent
        if (label?.includes('File: Hash')) {
          return row.querySelectorAll('td')[1]?.textContent?.trim() || ''
        }
      }
      return ''
    })
    expect(contentHash).not.toBe('')
    console.log('Content hash from Browser 1:', contentHash)

    // Verify Browser 1 has the file locally
    await expect(page1.locator('[data-testid="file-local-hash"]')).toHaveText(contentHash, { timeout: 5000 })

    // ========================================
    // Now verify Browser 2's behavior
    // ========================================

    // Browser 2: File card should appear (metadata synced via LiveStore)
    await expect(page2.locator('[data-testid="file-card"]')).toHaveCount(1, { timeout: 15000 })
    console.log('Browser 2: File card appeared (metadata synced)')

    // Browser 2: canDisplay should be true (remoteKey is set, can display via remote URL)
    await expect(page2.locator('[data-testid="file-can-display"]')).toHaveText('true', { timeout: 10000 })
    console.log('Browser 2: canDisplay is true')

    // Browser 2: Image should be visible (displayed via remote URL)
    await waitForImageLoaded(page2.locator('[data-testid="file-image"]'), 15000)
    console.log('Browser 2: Image loaded (via remote URL)')

    // Browser 2: Verify remoteKey is set
    const remoteKey = await page2.locator('[data-testid="file-remote-key"]').textContent()
    expect(remoteKey?.trim()).not.toBe('')
    console.log('Browser 2: remoteKey is set:', remoteKey)

    // ========================================
    // THE BUG: These assertions will fail
    // ========================================
    
    // Browser 2: downloadStatus should transition to "done"
    // This is the key assertion that will fail if the bug exists
    console.log('Browser 2: Waiting for downloadStatus to become "done"...')
    
    // First, let's log what the current state is
    const initialDownloadStatus = await page2.locator('[data-testid="file-download-status"]').textContent()
    const initialLocalHash = await page2.locator('[data-testid="file-local-hash"]').textContent()
    console.log('Browser 2 initial state - downloadStatus:', initialDownloadStatus, 'localHash:', initialLocalHash)

    // Wait for download to complete (this should happen automatically)
    await expect(page2.locator('[data-testid="file-download-status"]')).toHaveText('done', { timeout: 30000 })
    console.log('Browser 2: downloadStatus is "done"')

    // Browser 2: localHash should match the contentHash
    await expect(page2.locator('[data-testid="file-local-hash"]')).toHaveText(contentHash, { timeout: 5000 })
    console.log('Browser 2: localHash matches contentHash')

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
    test.skip(isReact, 'React has timing issues with multi-tab SharedWorker context - see LiveStore StoreProvider')
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
    test.skip(isReact, 'React has timing issues with multi-tab SharedWorker context - see LiveStore StoreProvider')
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

    // Navigate tabs sequentially and wait for each to complete initial sync
    // to avoid LiveStore WASM changeset race condition (see comment above)
    await browser1TabA.goto(url)
    await waitForLiveStoreAndSync(browser1TabA)

    await browser1TabB.goto(url)
    await waitForLiveStoreAndSync(browser1TabB)

    await browser2TabC.goto(url)
    await waitForLiveStoreAndSync(browser2TabC)

    await browser2TabD.goto(url)
    await waitForLiveStoreAndSync(browser2TabD)

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

test.describe('File Sync - Offline/Online Recovery', () => {
  test('should resume uploads when going from offline to online', async ({ browser }) => {
    const storeId = generateStoreId()
    const url = `/?storeId=${storeId}`

    // Create a new context so we can control offline state
    const context = await browser.newContext()
    const page = await context.newPage()

    await page.goto(url)
    await waitForLiveStoreAndSync(page)

    // Verify we start with empty state
    await expect(page.locator('[data-testid="empty-state"]')).toBeVisible()

    // Go offline BEFORE uploading (sets both Playwright context and LiveStore sync latch)
    await setOffline(page)

    // Upload a file - it should be queued but NOT uploaded
    const testImage = createTestImage('blue')
    await page.locator('input[type="file"]').setInputFiles(testImage)

    // Wait for file card to appear (local state is updated)
    await expect(page.locator('[data-testid="file-card"]')).toHaveCount(1, { timeout: 10000 })

    // Wait for image to load (from local OPFS storage)
    await waitForImageLoaded(page.locator('[data-testid="file-image"]'), 10000)

    // Wait a moment to ensure upload attempt would have been made
    await page.waitForTimeout(1000)

    // Verify the upload is pending (queued or has error from network failure)
    const uploadStatus = page.locator('[data-testid="file-upload-status"]')
    const statusText = await uploadStatus.textContent()
    // Upload could be queued, inProgress (stuck), or error (network failed)
    expect(['queued', 'inProgress', 'error']).toContain(statusText?.trim())

    // Remote key should be empty (not uploaded yet)
    const remoteKeyLocator = page.locator('[data-testid="file-remote-key"]')
    const remoteKeyBefore = await remoteKeyLocator.textContent()
    expect(remoteKeyBefore?.trim()).toBe('')

    // Go back online (sets both Playwright context and LiveStore sync latch, triggers online event)
    await setOnline(page)

    // Wait for upload to complete - upload status should become 'done'
    await expect(uploadStatus).toHaveText('done', { timeout: 30000 })

    // Verify the file now has a remote key
    await expect.poll(
      async () => (await remoteKeyLocator.textContent())?.trim() || '',
      { timeout: 15000 }
    ).not.toBe('')

    // Verify the file is accessible on remote storage
    const remoteKey = await getRemoteKey(page)
    const fileUrl = toRemoteUrl(page.url(), remoteKey)
    await waitForRemoteStatus(page, fileUrl, 200)

    // Cleanup
    await context.close()
  })

  test('should resume downloads when going from offline to online', async ({ browser }) => {
    const storeId = generateStoreId()
    const url = `/?storeId=${storeId}`

    // First, upload a file with context1 (online)
    const context1 = await browser.newContext()
    const page1 = await context1.newPage()

    await page1.goto(url)
    await waitForLiveStoreAndSync(page1)

    // Upload a file
    const testImage = createTestImage('red')
    await page1.locator('input[type="file"]').setInputFiles(testImage)

    // Wait for upload to complete
    await expect(page1.locator('[data-testid="file-card"]')).toHaveCount(1, { timeout: 10000 })
    await expect(page1.locator('[data-testid="file-upload-status"]')).toHaveText('done', {
      timeout: 15000,
    })

    // Get the remote key to verify file is uploaded
    const remoteKey = await getRemoteKey(page1)
    expect(remoteKey).not.toBe('')

    // Create context2 - we'll navigate online first, then go offline
    const context2 = await browser.newContext()
    const page2 = await context2.newPage()

    await page2.goto(url)
    await waitForLiveStoreAndSync(page2)

    // File metadata should sync via LiveStore
    // The file card should appear
    await expect(page2.locator('[data-testid="file-card"]')).toHaveCount(1, { timeout: 15000 })

    // Now go offline to interrupt any pending download
    await setOffline(page2)

    // Wait a moment for download attempt to be blocked/fail
    await page2.waitForTimeout(1000)

    // Download status could be in various states depending on timing
    const downloadStatus = page2.locator('[data-testid="file-download-status"]')
    const downloadStatusText = await downloadStatus.textContent()
    
    // If download already completed before we went offline, skip the recovery test part
    if (downloadStatusText?.trim() !== 'done') {
      // Verify download is blocked (queued, inProgress stuck, or error)
      expect(['queued', 'inProgress', 'error']).toContain(downloadStatusText?.trim())

      // Go back online (sets both Playwright context and LiveStore sync latch, triggers online event)
      await setOnline(page2)

      // Wait for download to complete
      await expect(downloadStatus).toHaveText('done', { timeout: 30000 })
    }

    // Verify canDisplay is true (either from download completing or from remote URL)
    await expect(page2.locator('[data-testid="file-can-display"]')).toHaveText('true', {
      timeout: 10000,
    })

    // Verify image is visible and loaded
    await waitForImageLoaded(page2.locator('[data-testid="file-image"]'), 15000)

    // Cleanup
    await context1.close()
    await context2.close()
  })

  test('should sync files uploaded by another browser while offline', async ({ browser }) => {
    // Test scenario:
    // 1. Browser 1 & 2 start online and syncing
    // 2. Browser 1 goes offline
    // 3. Browser 2 uploads a file
    // 4. Verify file does NOT sync to Browser 1 (it's offline)
    // 5. Browser 1 goes back online
    // 6. Verify file syncs to Browser 1 and displays correctly

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

    await waitForLiveStoreAndSync(page1)
    await waitForLiveStoreAndSync(page2)

    // Verify both start with empty state
    await expect(page1.locator('[data-testid="empty-state"]')).toBeVisible()
    await expect(page2.locator('[data-testid="empty-state"]')).toBeVisible()

    // Browser 1 goes offline
    await setOffline(page1)

    // Wait for offline state to fully take effect
    await page1.waitForTimeout(1000)

    // Browser 2 uploads a file (while Browser 1 is offline)
    const testImage = createTestImage('blue')
    await page2.locator('input[type="file"]').setInputFiles(testImage)

    // Wait for file to appear and upload to complete in Browser 2
    await expect(page2.locator('[data-testid="file-card"]')).toHaveCount(1, {
      timeout: 10000,
    })
    await expect(page2.locator('[data-testid="file-upload-status"]')).toHaveText('done', {
      timeout: 15000,
    })
    await waitForImageLoaded(page2.locator('[data-testid="file-image"]'), 10000)

    // Verify file is uploaded to remote
    const remoteKey = await getRemoteKey(page2)
    expect(remoteKey).not.toBe('')

    // Wait a moment and verify file has NOT synced to Browser 1 (it's offline)
    await page1.waitForTimeout(2000)
    const fileCardsWhileOffline = await page1.locator('[data-testid="file-card"]').count()
    expect(fileCardsWhileOffline).toBe(0)

    // Also verify empty state is still visible (no file card, no image)
    await expect(page1.locator('[data-testid="empty-state"]')).toBeVisible()
    await expect(page1.locator('[data-testid="file-image"]')).not.toBeVisible()

    // Browser 1 goes back online
    await setOnline(page1)

    // Verify file syncs to Browser 1
    await expect(page1.locator('[data-testid="file-card"]')).toHaveCount(1, {
      timeout: 15000,
    })

    // Verify canDisplay is true (file can be displayed from remote or after download)
    await expect(page1.locator('[data-testid="file-can-display"]')).toHaveText('true', {
      timeout: 15000,
    })

    // Verify image is visible and loaded in Browser 1
    await waitForImageLoaded(page1.locator('[data-testid="file-image"]'), 15000)

    // Cleanup
    await context1.close()
    await context2.close()
  })
})
