import { test, expect } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchShell, closeAndSaveVideo, waitForPageWithUrl, screenshotPath as makeScreenshotPath } from './helpers'

test('AI web search in pdf', async ({}, testInfo) => {
  test.setTimeout(90000)
  
  const startTime = Date.now()
  const logTime = () => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2)
    return `[${elapsed}s]`
  }

  console.log(`${logTime()} Start test: AI web search in pdf`)

  const scratch = await mkdtemp(join(tmpdir(), 'genoffice-pdf-ai-search-'))
  const document = join(scratch, 'test.pdf')
  
  const { app, page, userDataDir } = await launchShell({
    videoDir: 'pdf-ai-web-search',
    onboardingSeen: true,
    openFile: document,
  })

  try {
    console.log(`${logTime()} Opening pdf from home page`)
    await page.click('.quick-card:has-text("Blank"), .quick-card:has-text("PDF")')
    await page.waitForTimeout(3000)
    
    const pdf = await waitForPageWithUrl(app, 'pdf/out')
    await pdf.waitForFunction(() => document.readyState === 'complete', null, { timeout: 30000 })
    await pdf.waitForTimeout(2000)

    console.log(`${logTime()} Opening AI sidebar`)
    await pdf.waitForSelector('.ai-dock', { state: 'attached', timeout: 10000 })
    const aiDock = pdf.locator('.ai-dock').first()
    const isCollapsed = await aiDock.evaluate(el => el.classList.contains('collapsed'))
    if (isCollapsed) {
      console.log(`${logTime()} AI panel collapsed, expanding via .ai-rail`)
      await pdf.click('.ai-rail', { timeout: 5000 })
      await pdf.waitForTimeout(1000)
    }
    await pdf.waitForSelector('.ai-composer', { state: 'visible', timeout: 10000 })

    console.log(`${logTime()} Typing "web search eao"`)
    const chatInput = pdf.locator('.ai-input-box textarea').first()
    await chatInput.waitFor({ state: 'visible', timeout: 10000 })
    await chatInput.scrollIntoViewIfNeeded()
    await chatInput.fill('web search eao')
    await chatInput.press('Enter')

    console.log(`${logTime()} Waiting 5 seconds`)
    await pdf.waitForTimeout(5000)

    console.log(`${logTime()} Typing "web fetch http://eao.home"`)
    await chatInput.fill('web fetch http://eao.home')
    await chatInput.press('Enter')

    console.log(`${logTime()} Waiting for both AI responses via text content polling`)
    let chatText = ''
    let lastLength = 0
    let stableCount = 0
    for (let i = 0; i < 60; i++) {
      await pdf.waitForTimeout(1000)
      chatText = await aiDock.evaluate(el => {
        const clone = el.cloneNode(true) as HTMLElement
        const composer = clone.querySelector('.ai-composer')
        if (composer) composer.remove()
        return clone.innerText.trim()
      })
      
      const growth = Math.abs(chatText.length - lastLength)
      if (growth < 10) {
        stableCount++
      } else {
        stableCount = 0
      }
      lastLength = chatText.length
      
      if (chatText.length > 50 && stableCount >= 3) {
        console.log(`${logTime()} AI response stabilized after ${i + 1}s (${chatText.length} chars, stable for ${stableCount}s)`)
        break
      }
      
      if (i % 10 === 0 && chatText.length > 50) {
        console.log(`${logTime()} AI response growing... (${chatText.length} chars after ${i + 1}s)`)
      }
    }
    
    if (chatText.length <= 50) {
      const screenshotPathDebug = makeScreenshotPath('ai-web-search-pdf-debug')
      await pdf.screenshot({ path: screenshotPathDebug })
      throw new Error(`AI did not respond within 45s. Got: ${chatText.substring(0, 200)}`)
    }

    console.log(`${logTime()} Extracting full chat history`)
    const chatHistory = chatText

    console.log(`${logTime()} === CHAT HISTORY START ===`)
    console.log(chatHistory)
    console.log(`${logTime()} === CHAT HISTORY END ===`)
    
    testInfo.attachments.push({
      name: 'chat-history',
      body: Buffer.from(chatHistory, 'utf-8'),
      contentType: 'text/plain'
    })

    console.log(`${logTime()} Test completed successfully`)
  } catch (error) {
    console.error(`${logTime()} Test failed:`, error)
    const screenshotPathFailed = makeScreenshotPath('ai-web-search-pdf-failed')
    await page.screenshot({ path: screenshotPathFailed })
    throw error
  } finally {
    console.log(`${logTime()} Closing application`)
    await closeAndSaveVideo({ app, page, userDataDir }, 'pdf-ai-web-search')
  }
})
