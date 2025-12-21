import { test, expect } from '@playwright/test'

test('debug vue app', async ({ page }) => {
  const consoleMessages: string[] = []
  const pageErrors: string[] = []

  page.on('console', msg => {
    consoleMessages.push(`[${msg.type()}] ${msg.text()}`)
  })

  page.on('pageerror', err => {
    pageErrors.push(`[PAGE ERROR] ${err.message}`)
  })

  await page.goto('/')

  // Wait a bit
  await page.waitForTimeout(5000)

  // Log all messages
  console.log('\n--- Console Messages ---')
  for (const msg of consoleMessages) {
    console.log(msg)
  }

  console.log('\n--- Page Errors ---')
  for (const err of pageErrors) {
    console.log(err)
  }

  console.log('\n--- Page Content ---')
  console.log(await page.textContent('body'))

  // This test will fail so we can see the output
  expect(true).toBe(true)
})
