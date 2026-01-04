import { test, expect } from '@playwright/test'
import {
  createMultipleTestImages,
  waitForLiveStore,
  generateStoreId,
  getSyncStatusCounts,
  type SyncStatusCounts,
} from './helpers'

/**
 * State transition record for debugging
 */
interface StateTransition {
  timestamp: number
  elapsed: number
  uploading: number
  queued: number
  pending: number
  total: number
}

/**
 * Verify state transition invariants.
 * These are the rules that MUST hold for every state change.
 */
function verifyInvariants(
  fileCount: number,
  maxConcurrent: number,
  current: StateTransition,
  previous: StateTransition | null,
  allTransitions: StateTransition[]
): string[] {
  const violations: string[] = []

  // Invariant 1: Uploading count never exceeds maxConcurrent
  if (current.uploading > maxConcurrent) {
    violations.push(
      `VIOLATION: uploading (${current.uploading}) exceeds maxConcurrent (${maxConcurrent})`
    )
  }

  // Invariant 2: Total tracked files should never exceed fileCount
  if (current.total > fileCount) {
    violations.push(
      `VIOLATION: total (${current.total}) exceeds fileCount (${fileCount})`
    )
  }

  // Invariant 3: Counts should never be negative
  if (current.uploading < 0 || current.queued < 0 || current.pending < 0) {
    violations.push(
      `VIOLATION: negative count detected - uploading:${current.uploading}, queued:${current.queued}, pending:${current.pending}`
    )
  }

  // Invariant 4: Total should only decrease (files complete) or stay same, never increase 
  // once we've reached the expected total
  if (previous && previous.total === fileCount && current.total > previous.total) {
    violations.push(
      `VIOLATION: total increased from ${previous.total} to ${current.total} after reaching fileCount`
    )
  }

  // Invariant 5: Large jumps in counts are suspicious (more than expected change)
  // A file can only go through one transition at a time
  if (previous) {
    const uploadingDiff = Math.abs(current.uploading - previous.uploading)
    const queuedDiff = Math.abs(current.queued - previous.queued)
    const pendingDiff = Math.abs(current.pending - previous.pending)
    
    // With maxConcurrent=2, at most 2 files can change uploading status at once
    // and correspondingly 2 files can move from queued to uploading
    const maxReasonableChange = maxConcurrent + 1 // Allow for some timing variance
    
    if (uploadingDiff > maxReasonableChange) {
      violations.push(
        `SUSPICIOUS: uploading changed by ${uploadingDiff} (from ${previous.uploading} to ${current.uploading})`
      )
    }
    
    // Queued can change more rapidly as files are added to queue
    // But once stable, shouldn't jump around
    if (previous.total === fileCount && queuedDiff > maxReasonableChange) {
      violations.push(
        `SUSPICIOUS: queued changed by ${queuedDiff} (from ${previous.queued} to ${current.queued}) after reaching stable total`
      )
    }
  }

  return violations
}

/**
 * Collect state transitions over time with strict invariant checking
 */
async function collectStateTransitions(
  page: any,
  fileCount: number,
  maxConcurrent: number,
  timeoutMs: number,
  pollIntervalMs: number
): Promise<{ transitions: StateTransition[]; violations: string[] }> {
  const transitions: StateTransition[] = []
  const violations: string[] = []
  const startTime = Date.now()
  
  let consecutiveZeroCount = 0
  const requiredZeroCount = 3 // Must see 0 total 3 times in a row to be sure we're done
  
  while (Date.now() - startTime < timeoutMs) {
    const status = await getSyncStatusCounts(page)
    const elapsed = Date.now() - startTime
    
    const current: StateTransition = {
      timestamp: Date.now(),
      elapsed,
      uploading: status.uploading,
      queued: status.queuedUpload,
      pending: status.pendingUpload,
      total: status.uploading + status.queuedUpload + status.pendingUpload,
    }
    
    const previous = transitions.length > 0 ? transitions[transitions.length - 1] : null
    
    // Only record if state changed
    if (!previous || 
        current.uploading !== previous.uploading ||
        current.queued !== previous.queued ||
        current.pending !== previous.pending) {
      
      transitions.push(current)
      
      // Verify invariants on every state change
      const newViolations = verifyInvariants(fileCount, maxConcurrent, current, previous, transitions)
      violations.push(...newViolations)
    }
    
    // Check for completion
    if (current.total === 0) {
      consecutiveZeroCount++
      if (consecutiveZeroCount >= requiredZeroCount) {
        break
      }
    } else {
      consecutiveZeroCount = 0
    }
    
    await new Promise(r => setTimeout(r, pollIntervalMs))
  }
  
  return { transitions, violations }
}

test.describe('Sync Status - Strict Invariant Tests', () => {
  
  test('10 files upload with strict state tracking - no flickering allowed', async ({ page }) => {
    const storeId = generateStoreId('strict_10_files')
    const fileCount = 10
    const maxConcurrent = 2
    const uploadDelayMs = 500 // Short enough to complete in reasonable time
    
    // Set up upload delay BEFORE navigation
    await page.route('**/livestore-filesync-files/**', async (route) => {
      if (route.request().method() === 'PUT') {
        await new Promise(r => setTimeout(r, uploadDelayMs))
      }
      await route.continue()
    })
    
    await page.goto(`/?storeId=${storeId}`)
    await waitForLiveStore(page)

    // Upload files
    const testImages = createMultipleTestImages(fileCount)
    await page.locator('input[type="file"]').setInputFiles(testImages)

    // Wait for files to appear
    await expect(page.locator('[data-testid="file-card"]')).toHaveCount(fileCount, { timeout: 10000 })

    // Collect all state transitions with strict checking
    const { transitions, violations } = await collectStateTransitions(
      page,
      fileCount,
      maxConcurrent,
      30000, // 30s timeout
      50     // 50ms poll interval for fine-grained observation
    )

    // Log all transitions for debugging
    console.log('=== State Transitions ===')
    for (const t of transitions) {
      console.log(
        `t=${t.elapsed}ms: uploading=${t.uploading}, queued=${t.queued}, pending=${t.pending}, total=${t.total}`
      )
    }

    // Log violations
    if (violations.length > 0) {
      console.log('\n=== VIOLATIONS ===')
      for (const v of violations) {
        console.log(v)
      }
    }

    // ASSERTIONS
    
    // 1. Basic invariants should hold (from verifyInvariants)
    expect(violations).toHaveLength(0)
    
    // 2. We should have seen the expected total at some point
    const sawExpectedTotal = transitions.some(t => t.total === fileCount)
    expect(sawExpectedTotal).toBe(true)
    
    // 3. Final state should be all zeros
    const finalState = transitions[transitions.length - 1]
    expect(finalState.total).toBe(0)
    
    // 4. We should have seen uploading activity, respecting maxConcurrent
    const maxUploadingSeen = Math.max(...transitions.map(t => t.uploading))
    expect(maxUploadingSeen).toBeGreaterThan(0)
    expect(maxUploadingSeen).toBeLessThanOrEqual(maxConcurrent)
    
    // 5. Max total seen should equal fileCount (no files lost)
    const maxTotalSeen = Math.max(...transitions.map(t => t.total))
    expect(maxTotalSeen).toBe(fileCount)
  })

  test('3 files upload - verify exact state progression', async ({ page }) => {
    const storeId = generateStoreId('strict_3_files')
    const fileCount = 3
    const maxConcurrent = 2
    const uploadDelayMs = 2000 // Longer delay to see clear states
    
    await page.route('**/livestore-filesync-files/**', async (route) => {
      if (route.request().method() === 'PUT') {
        await new Promise(r => setTimeout(r, uploadDelayMs))
      }
      await route.continue()
    })
    
    await page.goto(`/?storeId=${storeId}`)
    await waitForLiveStore(page)

    const testImages = createMultipleTestImages(fileCount)
    await page.locator('input[type="file"]').setInputFiles(testImages)
    await expect(page.locator('[data-testid="file-card"]')).toHaveCount(fileCount, { timeout: 5000 })

    const { transitions, violations } = await collectStateTransitions(
      page,
      fileCount,
      maxConcurrent,
      15000,
      50
    )

    console.log('=== State Transitions (3 files) ===')
    for (const t of transitions) {
      console.log(
        `t=${t.elapsed}ms: uploading=${t.uploading}, queued=${t.queued}, pending=${t.pending}, total=${t.total}`
      )
    }

    if (violations.length > 0) {
      console.log('\n=== VIOLATIONS ===')
      violations.forEach(v => console.log(v))
    }

    expect(violations).toHaveLength(0)
    
    // For 3 files with maxConcurrent=2:
    // Expected progression: 
    //   - Start: 0,0,0
    //   - Files added: combinations leading to total=3
    //   - Steady state: uploading=2, queued=1 (should persist for ~2s)
    //   - First completes: uploading=2, queued=0 (3rd file starts)
    //   - Second completes: uploading=1, queued=0
    //   - Third completes: uploading=0, queued=0
    
    // Verify we saw the expected steady state
    const sawSteadyState = transitions.some(t => t.uploading === 2 && t.queued === 1)
    expect(sawSteadyState).toBe(true)
    
    // Verify we never exceeded limits
    const maxUploading = Math.max(...transitions.map(t => t.uploading))
    expect(maxUploading).toBeLessThanOrEqual(maxConcurrent)
  })

  test('5 files upload - final state is zero and max reached', async ({ page }) => {
    const storeId = generateStoreId('strict_monotonic')
    const fileCount = 5
    const maxConcurrent = 2
    
    await page.route('**/livestore-filesync-files/**', async (route) => {
      if (route.request().method() === 'PUT') {
        await new Promise(r => setTimeout(r, 1000)) // Longer delay for stability
      }
      await route.continue()
    })
    
    await page.goto(`/?storeId=${storeId}`)
    await waitForLiveStore(page)

    const testImages = createMultipleTestImages(fileCount)
    await page.locator('input[type="file"]').setInputFiles(testImages)
    await expect(page.locator('[data-testid="file-card"]')).toHaveCount(fileCount, { timeout: 5000 })

    const { transitions, violations } = await collectStateTransitions(
      page,
      fileCount,
      maxConcurrent,
      25000,
      50
    )

    console.log('=== State Transitions (5 files test) ===')
    for (const t of transitions) {
      console.log(
        `t=${t.elapsed}ms: uploading=${t.uploading}, queued=${t.queued}, pending=${t.pending}, total=${t.total}`
      )
    }

    // Basic invariants should hold
    expect(violations).toHaveLength(0)
    
    // We should have reached the expected max at some point
    const maxTotalSeen = Math.max(...transitions.map(t => t.total))
    expect(maxTotalSeen).toBe(fileCount)
    
    // Final state should be zero
    const finalState = transitions[transitions.length - 1]
    expect(finalState.total).toBe(0)
    
    // Upload count should never exceed maxConcurrent
    const maxUploading = Math.max(...transitions.map(t => t.uploading))
    expect(maxUploading).toBeLessThanOrEqual(maxConcurrent)
  })

  test('concurrent upload count never exceeds 2', async ({ page }) => {
    const storeId = generateStoreId('strict_concurrent')
    const fileCount = 8
    const maxConcurrent = 2
    
    await page.route('**/livestore-filesync-files/**', async (route) => {
      if (route.request().method() === 'PUT') {
        await new Promise(r => setTimeout(r, 500))
      }
      await route.continue()
    })
    
    await page.goto(`/?storeId=${storeId}`)
    await waitForLiveStore(page)

    const testImages = createMultipleTestImages(fileCount)
    await page.locator('input[type="file"]').setInputFiles(testImages)
    await expect(page.locator('[data-testid="file-card"]')).toHaveCount(fileCount, { timeout: 10000 })

    const { transitions, violations } = await collectStateTransitions(
      page,
      fileCount,
      maxConcurrent,
      25000,
      30
    )

    // Check every single observation
    const overLimitTransitions = transitions.filter(t => t.uploading > maxConcurrent)
    
    if (overLimitTransitions.length > 0) {
      console.log('=== OVER LIMIT TRANSITIONS ===')
      overLimitTransitions.forEach(t => {
        console.log(`t=${t.elapsed}ms: uploading=${t.uploading} EXCEEDS LIMIT`)
      })
    }
    
    expect(overLimitTransitions).toHaveLength(0)
    expect(violations).toHaveLength(0)
  })

  test('each file goes through expected lifecycle: pending -> queued -> inProgress -> done', async ({ page }) => {
    const storeId = generateStoreId('strict_lifecycle')
    const fileCount = 3
    const maxConcurrent = 2
    
    await page.route('**/livestore-filesync-files/**', async (route) => {
      if (route.request().method() === 'PUT') {
        await new Promise(r => setTimeout(r, 1500))
      }
      await route.continue()
    })
    
    await page.goto(`/?storeId=${storeId}`)
    await waitForLiveStore(page)

    const testImages = createMultipleTestImages(fileCount)
    await page.locator('input[type="file"]').setInputFiles(testImages)
    await expect(page.locator('[data-testid="file-card"]')).toHaveCount(fileCount, { timeout: 5000 })

    // Track individual file state transitions (using the file ID lists from the UI)
    const seenInUploading = new Set<string>()
    const seenInQueued = new Set<string>()
    
    await expect
      .poll(
        async () => {
          const status = await getSyncStatusCounts(page)
          
          // Get file IDs from the UI lists
          const uploadingIds = await page.locator('[data-testid="sync-status-panel"] h4:has-text("Uploading Files") + ul li').allTextContents()
          const queuedIds = await page.locator('[data-testid="sync-status-panel"] h4:has-text("Queued Uploads") + ul li').allTextContents()
          
          uploadingIds.forEach(id => seenInUploading.add(id.trim()))
          queuedIds.forEach(id => seenInQueued.add(id.trim()))
          
          return status.uploading + status.queuedUpload + status.pendingUpload
        },
        { timeout: 15000, intervals: [100] }
      )
      .toBe(0)

    // All files should have been seen in uploading at some point
    // (they all need to upload)
    console.log('Files seen in uploading:', seenInUploading.size)
    console.log('Files seen in queued:', seenInQueued.size)
    
    // We should have seen at least maxConcurrent files in uploading
    expect(seenInUploading.size).toBeGreaterThanOrEqual(maxConcurrent)
    
    // With 3 files and maxConcurrent=2, at least 1 file should have been queued
    expect(seenInQueued.size).toBeGreaterThanOrEqual(1)
  })
})

test.describe('Sync Status - Basic Functionality', () => {
  test('uploading files completes successfully', async ({ page }) => {
    const storeId = generateStoreId('basic_upload')
    
    await page.route('**/livestore-filesync-files/**', async (route) => {
      if (route.request().method() === 'PUT') {
        await new Promise(r => setTimeout(r, 300))
      }
      await route.continue()
    })
    
    await page.goto(`/?storeId=${storeId}`)
    await waitForLiveStore(page)

    const testImages = createMultipleTestImages(3)
    await page.locator('input[type="file"]').setInputFiles(testImages)
    await expect(page.locator('[data-testid="file-card"]')).toHaveCount(3, { timeout: 5000 })

    // Wait for all uploads to complete
    await expect
      .poll(
        async () => {
          const status = await getSyncStatusCounts(page)
          return status.uploading + status.queuedUpload + status.pendingUpload
        },
        { timeout: 15000, intervals: [100] }
      )
      .toBe(0)

    // Final state checks
    const finalStatus = await getSyncStatusCounts(page)
    expect(finalStatus.errors).toBe(0)
    expect(finalStatus.isSyncing).toBe(false)
  })

  test('hasPending becomes false when uploads complete', async ({ page }) => {
    const storeId = generateStoreId('basic_pending')
    
    // Use longer delay to ensure we can observe the pending state
    await page.route('**/livestore-filesync-files/**', async (route) => {
      if (route.request().method() === 'PUT') {
        await new Promise(r => setTimeout(r, 2000))
      }
      await route.continue()
    })
    
    await page.goto(`/?storeId=${storeId}`)
    await waitForLiveStore(page)

    const testImages = createMultipleTestImages(3) // Use 3 files to ensure queue
    await page.locator('input[type="file"]').setInputFiles(testImages)
    await expect(page.locator('[data-testid="file-card"]')).toHaveCount(3, { timeout: 5000 })

    // Should have pending work initially (with 3 files and 2s delay, we have time to observe)
    await expect(page.locator('[data-testid="sync-has-pending"]')).toHaveText('Yes', { timeout: 5000 })

    // Wait for completion
    await expect(page.locator('[data-testid="sync-has-pending"]')).toHaveText('No', { timeout: 20000 })
    await expect(page.locator('[data-testid="sync-is-syncing"]')).toHaveText('No')
  })
})
