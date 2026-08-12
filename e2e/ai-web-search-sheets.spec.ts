import { test, expect } from '@playwright/test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchShell, closeAndSaveVideo, waitForPageWithUrl, screenshotPath as makeScreenshotPath } from './helpers'

test('AI web search in sheets', async ({}, testInfo) => {
  test.setTimeout(90000)
  
  const startTime = Date.now()
  const logTime = () => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2)
    return `[${elapsed}s]`
  }

  console.log(`${logTime()} Start test: AI web search in sheets`)

  const scratch = await mkdtemp(join(tmpdir(), 'genoffice-sheets-ai-search-'))
  const document = join(scratch, 'test.xlsx')
  
  const userDataDir = await mkdtemp(join(tmpdir(), 'genoffice-sheets-ai-search-'))
  
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
    videoDir: 'sheets-ai-web-search',
    onboardingSeen: true,
    openFile: document,
    userDataDir,
  })

  try {
    console.log(`${logTime()} Opening sheets from home page`)
    await page.click('.quick-card:has-text("Blank"), .quick-card:has-text("Sheets")')
    
    const sheets = await waitForPageWithUrl(app, 'sheets/out')
    await sheets.waitForFunction(() => document.readyState === 'complete', null, { timeout: 60000 })
    await sheets.waitForTimeout(5000)

    console.log(`${logTime()} Waiting for sheets UI to render`)
    await sheets.waitForSelector('.excel-header, .ribbon-tabs', { state: 'visible', timeout: 30000 })
    await sheets.waitForTimeout(3000)

    console.log(`${logTime()} Waiting for AI panel`)
    // AI panel is open by default in sheets, wait for composer
    await sheets.waitForSelector('.ai-composer', { state: 'visible', timeout: 15000 })

    console.log(`${logTime()} Getting AI dock reference`)
    const aiDock = sheets.locator('.copilot, .ai-dock, [class*="ai-sidebar"]').first()
    await aiDock.waitFor({ state: 'visible', timeout: 30000 })

    console.log(`${logTime()} Typing "web search eao"`)
    const chatInput = sheets.locator('.ai-input-box textarea').first()
    await chatInput.waitFor({ state: 'visible', timeout: 10000 })
    await chatInput.scrollIntoViewIfNeeded()
    await chatInput.fill('web search eao')
    await chatInput.press('Enter')

    console.log(`${logTime()} Waiting 15 seconds for web search response`)
    await sheets.waitForTimeout(15000)

    console.log(`${logTime()} Typing "web fetch http://eao.home"`)
    await chatInput.fill('web fetch http://eao.home')
    await chatInput.press('Enter')

    console.log(`${logTime()} Waiting 15 seconds for web fetch response`)
    await sheets.waitForTimeout(15000)

    console.log(`${logTime()} Waiting for both AI responses via text content polling`)
    let chatText = ''
    let lastLength = 0
    let stableCount = 0
    for (let i = 0; i < 60; i++) {
      await sheets.waitForTimeout(1000)
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
      const screenshotPathDebug = makeScreenshotPath('ai-web-search-sheets-debug')
      await sheets.screenshot({ path: screenshotPathDebug })
      throw new Error(`AI did not respond within 45s. Got: ${chatText.substring(0, 200)}`)
    }

    console.log(`${logTime()} Extracting full chat history`)
    const chatHistory = chatText

    console.log(`${logTime()} === CHAT HISTORY START ===`)
    console.log(chatHistory)
    console.log(`${logTime()} === CHAT HISTORY END ===`)

    console.log(`${logTime()} Verifying both web search and web fetch responses`)
    const hasWebSearch = chatHistory.toLowerCase().includes('web search') || chatHistory.toLowerCase().includes('eao')
    const hasWebFetch = chatHistory.toLowerCase().includes('web fetch') || chatHistory.toLowerCase().includes('http://eao.home')
    
    if (!hasWebSearch) {
      throw new Error('Chat does not contain web search response')
    }
    if (!hasWebFetch) {
      throw new Error('Chat does not contain web fetch response')
    }
    
    console.log(`${logTime()} Both web search and web fetch responses verified`)
    
    testInfo.attachments.push({
      name: 'chat-history',
      body: Buffer.from(chatHistory, 'utf-8'),
      contentType: 'text/plain'
    })

    console.log(`${logTime()} Test completed successfully`)
  } catch (error) {
    console.error(`${logTime()} Test failed:`, error)
    const screenshotPathFailed = makeScreenshotPath('ai-web-search-sheets-failed')
    await page.screenshot({ path: screenshotPathFailed })
    throw error
  } finally {
    console.log(`${logTime()} Closing application`)
    await closeAndSaveVideo({ app, page, userDataDir }, 'sheets-ai-web-search')
  }
})
