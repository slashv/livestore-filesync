import { test as base, expect, Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/**
 * Test data-testid selectors that all framework implementations should provide.
 * These are the contract between the tests and the UI implementations.
 */
export const selectors = {
  // Gallery container
  gallery: '[data-testid="gallery"]',

  // Upload controls
  uploadButton: '[data-testid="upload-button"]',
  fileInput: '[data-testid="file-input"], input[type="file"]',

  // File cards
  fileCard: '[data-testid="file-card"]',
  fileImage: '[data-testid="file-image"]',
  fileName: '[data-testid="file-name"]',
  fileStatus: '[data-testid="file-status"]',
  deleteButton: '[data-testid="delete-button"]',

  // Status indicators
  onlineStatus: '[data-testid="online-status"]',
  offlineStatus: '[data-testid="offline-status"]',
  statusIndicator: '[data-testid="status-indicator"]',

  // Loading states
  loading: '[data-testid="loading"]',
  emptyState: '[data-testid="empty-state"]',
} as const

/**
 * Page object for interacting with the file sync gallery
 */
export class GalleryPage {
  constructor(private page: Page) {}

  async goto() {
    await this.page.goto('/')
    // Wait for LiveStore to load (it shows "Loading LiveStore" while initializing)
    await this.page.waitForFunction(() => {
      // Check if LiveStore loading message is gone
      const loadingText = document.body.innerText
      return !loadingText.includes('Loading LiveStore')
    }, { timeout: 60000 })
    // Now wait for the gallery to be ready
    await this.page.waitForSelector(selectors.gallery, { timeout: 30000 })
  }

  async waitForReady() {
    // Wait for loading to complete
    await this.page.waitForFunction(() => {
      const loading = document.querySelector('[data-testid="loading"]')
      return !loading || loading.textContent?.includes('loaded')
    }, { timeout: 30000 })
  }

  async uploadFile(filePath: string) {
    const fileInput = this.page.locator(selectors.fileInput)

    // Handle hidden file inputs (common pattern)
    await fileInput.setInputFiles(filePath)
  }

  async uploadTestImage(name = 'test-image.png') {
    const testImagePath = path.join(__dirname, '../fixtures', name)

    // Create test fixtures directory if needed
    const fixturesDir = path.join(__dirname, '../fixtures')
    if (!fs.existsSync(fixturesDir)) {
      fs.mkdirSync(fixturesDir, { recursive: true })
    }

    // Create a test image if it doesn't exist
    if (!fs.existsSync(testImagePath)) {
      // Create a simple 1x1 red PNG
      const pngData = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
        0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, // IDAT chunk
        0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
        0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xfe,
        0xd4, 0xef, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, // IEND chunk
        0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
      ])
      fs.writeFileSync(testImagePath, pngData)
    }

    await this.uploadFile(testImagePath)
    return name
  }

  async getFileCards() {
    return this.page.locator(selectors.fileCard).all()
  }

  async getFileCardByName(name: string) {
    return this.page.locator(selectors.fileCard).filter({
      has: this.page.locator(`text="${name}"`)
    })
  }

  async getFileCount() {
    const cards = await this.getFileCards()
    return cards.length
  }

  async deleteFile(name: string) {
    const card = await this.getFileCardByName(name)
    await card.locator(selectors.deleteButton).click()
  }

  async getFileStatus(name: string) {
    const card = await this.getFileCardByName(name)
    const status = card.locator(selectors.fileStatus)
    return status.textContent()
  }

  async isOnline() {
    const online = this.page.locator(selectors.onlineStatus)
    const offline = this.page.locator(selectors.offlineStatus)
    const indicator = this.page.locator(selectors.statusIndicator)

    // Check various ways the status might be indicated
    if (await online.isVisible().catch(() => false)) {
      return true
    }
    if (await offline.isVisible().catch(() => false)) {
      return false
    }

    const indicatorText = await indicator.textContent().catch(() => '')
    return indicatorText?.toLowerCase().includes('online') ?? true
  }

  async waitForFileStatus(name: string, status: string, timeout = 10000) {
    const card = await this.getFileCardByName(name)
    await expect(card.locator(selectors.fileStatus)).toContainText(status, { timeout })
  }

  async isEmpty() {
    const emptyState = this.page.locator(selectors.emptyState)
    return emptyState.isVisible().catch(() => false)
  }
}

/**
 * Extended test fixtures with GalleryPage
 */
export const test = base.extend<{ galleryPage: GalleryPage }>({
  galleryPage: async ({ page }, use) => {
    const galleryPage = new GalleryPage(page)
    await use(galleryPage)
  },
})

export { expect }
