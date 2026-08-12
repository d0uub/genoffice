// test.common.js - Common utilities for CDP testing
const { chromium } = require('playwright');

let browser = null;
let page = null;
let client = null;

/**
 * Connect to Electron via CDP
 * @param {number} port - Debug port (default: 9224)
 * @returns {Promise<object>} - { browser, page, client }
 */
async function connectCDP(port = 9224, pageId = null) {
  const wsEndpoint = `http://localhost:${port}`;
  console.log(`[${new Date().toISOString().split('T')[1].split('.')[0]}] Connecting to ${wsEndpoint}`);
  
  browser = await chromium.connectOverCDP(wsEndpoint);
  const context = browser.contexts()[0];
  let pages = context.pages();
  
  // Find GenOffice Slides page (skip DevTools)
  for (const p of pages) {
    const title = await p.title();
    const url = p.url();
    console.log(`  Page: ${title} - ${url}`);
    if (title.includes('GenOffice') && !url.includes('devtools')) {
      page = p;
      break;
    }
  }
  
  if (!page && pages.length > 0) {
    page = pages[0];
  }
  
  if (!page) {
    page = await context.newPage();
  }
  
  client = await page.context().newCDPSession(page);
  await client.send('Page.enable');
  await client.send('DOM.enable');
  await client.send('Runtime.enable');
  
  console.log(`[${new Date().toISOString().split('T')[1].split('.')[0]}] Connected`);
  return { browser, page, client };
}

/**
 * Wait for element to exist
 * @param {string} selector - CSS selector
 * @param {number} timeout - Timeout in ms
 * @returns {Promise<boolean>}
 */
async function waitForElement(selector, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const exists = await page.evaluate((sel) => {
      return document.querySelector(sel) !== null;
    }, selector);
    
    if (exists) {
      console.log(`[${new Date().toISOString().split('T')[1].split('.')[0]}] Element found: ${selector}`);
      return true;
    }
    
    await new Promise(r => setTimeout(r, 500));
  }
  
  console.log(`[${new Date().toISOString().split('T')[1].split('.')[0]}] Timeout waiting for: ${selector}`);
  return false;
}

/**
 * Inject text into element
 * @param {string} selector - CSS selector
 * @param {string} text - Text to inject
 */
async function injectText(selector, text) {
  const result = await page.evaluate((sel, txt) => {
    const el = document.querySelector(sel);
    if (el) {
      el.value = txt;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return 'success';
    }
    return 'not found';
  }, selector, text);
  
  console.log(`[${new Date().toISOString().split('T')[1].split('.')[0]}] Inject ${selector}: ${result}`);
  return result;
}

/**
 * Capture screenshot via CDP
 * @returns {Promise<string>} - Base64 screenshot
 */
async function captureScreenshot() {
  const screenshot = await client.send('Page.captureScreenshot', { format: 'png' });
  console.log(`[${new Date().toISOString().split('T')[1].split('.')[0]}] Screenshot: ${screenshot.data.length} bytes`);
  return screenshot.data;
}

/**
 * Get element text
 * @param {string} selector - CSS selector
 * @returns {Promise<string>}
 */
async function getElementText(selector) {
  return await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? el.textContent : null;
  }, selector);
}

/**
 * Close connection
 */
async function disconnect() {
  if (browser) {
    await browser.close();
    console.log(`[${new Date().toISOString().split('T')[1].split('.')[0]}] Disconnected`);
  }
}

module.exports = {
  connectCDP,
  waitForElement,
  injectText,
  captureScreenshot,
  getElementText,
  disconnect
};
