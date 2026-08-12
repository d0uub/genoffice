import { test, expect } from '@playwright/test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchShell, closeAndSaveVideo, waitForPageWithUrl, screenshotPath as makeScreenshotPath } from './helpers'

test('AI web search in docs', async ({}, testInfo) => {
  test.setTimeout(180000)
  
  const startTime = Date.now()
  const logTime = () => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2)
    return `[${elapsed}s]`
  }

  console.log(`${logTime()} Start test: AI web search in docs`)

  const scratch = await mkdtemp(join(tmpdir(), 'genoffice-docs-ai-search-'))
  const testDocPath = join(scratch, 'test.docx')
  
  const userDataDir = await mkdtemp(join(tmpdir(), 'genoffice-docs-ai-search-'))
  
  const userAiSettingsPath = join('C:', 'Users', 'cht132', 'AppData', 'Roaming', 'GenOffice Docs Dev', 'ai-settings.json')
  try {
    const userAiSettings = readFileSync(userAiSettingsPath, 'utf-8')
    writeFileSync(join(userDataDir, 'ai-settings.json'), userAiSettings)
    console.log(`${logTime()} Copied user ai-settings.json from ${userAiSettingsPath}`)
  } catch (err) {
    console.log(`${logTime()} User ai-settings.json not found, using empty config`)
    writeFileSync(
      join(userDataDir, 'ai-settings.json'),
      JSON.stringify({}),
    )
  }
  
  const { app, page } = await launchShell({
    videoDir: 'docs-ai-web-search',
    onboardingSeen: true,
    openFile: testDocPath,
    userDataDir,
  })

  try {
    console.log(`${logTime()} Opening docs from home page`)
    await page.click('.quick-card:has-text("Blank"), .quick-card:has-text("Docs")')
    // await page.waitForTimeout(3000)
    
    const docs = await waitForPageWithUrl(app, 'docs/out')
    await docs.waitForFunction(() => window.document.readyState === 'complete', null, { timeout: 30000 })
    await docs.waitForTimeout(1000)

    console.log(`${logTime()} Opening AI sidebar`)
    await docs.waitForSelector('.ai-dock', { state: 'attached', timeout: 10000 })
    const aiDock = docs.locator('.ai-dock').first()
    const isCollapsed = await aiDock.evaluate(el => el.classList.contains('collapsed'))
    if (isCollapsed) {
      console.log(`${logTime()} AI panel collapsed, expanding via .ai-rail`)
      await docs.click('.ai-rail', { timeout: 5000 })
      await docs.waitForTimeout(1000)
    }
    await docs.waitForSelector('.ai-composer', { state: 'visible', timeout: 10000 })

    console.log(`${logTime()} Typing "web search eao"`)
    const chatInput = docs.locator('.ai-input-box textarea').first()
    // await chatInput.waitFor({ state: 'visible', timeout: 10000 })
    // await chatInput.scrollIntoViewIfNeeded()
    // await chatInput.fill('web search eao')
    // await chatInput.press('Enter')

    // console.log(`${logTime()} Waiting 5 seconds`)
    // await docs.waitForTimeout(5000)

    console.log(`${logTime()} Typing "web fetch http://eao.home"`)
    await chatInput.fill('web fetch http://eao.home')
    await chatInput.press('Enter')

    console.log(`${logTime()} Waiting for AI web fetch tool call via text content polling`)
    let chatText = ''
    let lastLength = 0
    let stableCount = 0
    for (let i = 0; i < 120; i++) {
      await docs.waitForTimeout(1000)
      chatText = await aiDock.evaluate(el => {
        const clone = el.cloneNode(true) as HTMLElement
        const composer = clone.querySelector('.ai-composer')
        if (composer) composer.remove()
        return clone.innerText.trim()
      })
      
      // Check if content has stabilized (no significant growth for 5 seconds)
      const growth = Math.abs(chatText.length - lastLength)
      if (growth < 10) {
        stableCount++
      } else {
        stableCount = 0
      }
      lastLength = chatText.length
      
      if (chatText.length > 50 && stableCount >= 5) {
        console.log(`${logTime()} AI response stabilized after ${i + 1}s (${chatText.length} chars, stable for ${stableCount}s)`)
        break
      }
      
      if (i % 10 === 0 && chatText.length > 50) {
        console.log(`${logTime()} AI response growing... (${chatText.length} chars after ${i + 1}s)`)
      }
    }
    
    if (chatText.length <= 50) {
      const screenshotPathDebug = makeScreenshotPath('ai-web-search-docs-debug')
      await docs.screenshot({ path: screenshotPathDebug })
      throw new Error(`AI did not respond within 110s. Got: ${chatText.substring(0, 200)}`)
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

    console.log(`${logTime()} Verifying AI called web_fetch tool`)
    // Check multiple indicators that webFetch was called
    const indicators = [
      'example.com',
      'fetch',
      'html',
      'markdown',
      'web page',
      'website',
      'content from',
      'retrieved from'
    ]
    const chatLower = chatHistory.toLowerCase()
    const foundIndicators = indicators.filter(ind => chatLower.includes(ind))
    const calledWebFetch = foundIndicators.length >= 2 // At least 2 indicators suggest web fetch was used
    
    console.log(`${logTime()} Found indicators: ${foundIndicators.join(', ')}`)
    if (calledWebFetch) {
      console.log(`${logTime()} ✓ AI called web_fetch successfully`)
    } else {
      console.log(`${logTime()} ✗ AI response does not contain web_fetch indicators`)
      console.log(`${logTime()} Chat history preview: ${chatHistory.substring(0, 500)}`)
    }
    
    expect(calledWebFetch).toBeTruthy()

    console.log(`${logTime()} Test completed successfully`)
  } catch (error) {
    console.error(`${logTime()} Test failed:`, error)
    const screenshotPathFailed = makeScreenshotPath('ai-web-search-docs-failed')
    await page.screenshot({ path: screenshotPathFailed })
    throw error
  } finally {
    console.log(`${logTime()} Closing application`)
    await closeAndSaveVideo({ app, page, userDataDir }, 'docs-ai-web-search')
  }
})
