/**
 * Search utilities (main process) — gsk (Genspark CLI) first, then Serper Google API,
 * with DuckDuckGo as the last resort. The Serper/DuckDuckGo logic mirrors an earlier
 * web_search / google_image_search implementation. Runs in the main process
 * (Node fetch / child process) to avoid renderer CORS; the Serper key reuses SERPER_API_KEY.
 * For gsk auth see ./gsk.ts (`gsk login` or GSK_API_KEY).
 */

import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import TurndownService from 'turndown'
import * as cheerio from 'cheerio'
import { fetchWithSsrfGuard } from '@genoffice/electron-utils'
import { get } from 'node:http'
import { request as httpsRequest } from 'node:https'

const LOG_FILE = 'C:\\temp\\genoffice-websearch.log'
const log = (msg: string) => {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  console.log(msg)
  try {
    appendFileSync(LOG_FILE, line)
  } catch (e) {
    console.error('[webSearch] failed to write log:', e)
  }
}
import {
  COPYRIGHT_HOSTS,
  asRecord,
  safeHost,
  type ImageSearchResult,
  type WebSearchResult,
} from './shared'
import { gskChildEnv, gskImageSearch, gskProxyUrl, gskWebSearch, hasGskAuth } from './gsk'

export type { ImageSearchResult, WebSearchResult } from './shared'
export * from './gsk'
export * from './genoffice-auth'

const SERPER_KEY = () => process.env.SERPER_API_KEY ?? ''

// ── Web search ──────────────────────────────────────────────────────

export async function webSearch(
  query: string,
  maxResults = 6,
): Promise<{
  results: WebSearchResult[]
  answer?: string
  method: string
}> {
  const gskAuth = hasGskAuth()
  const serperKey = SERPER_KEY()
  log(`[webSearch] hasGskAuth: ${gskAuth}, SERPER_KEY: ${serperKey ? 'present' : 'missing'}`)
  if (gskAuth) {
    try {
      log(`[webSearch] calling gskWebSearch with query: "${query}"`)
      const r = await gskWebSearch(query, maxResults)
      if (r.results.length) {
        log(`[webSearch] gsk success, results: ${r.results.length}`)
        return { ...r, method: 'gsk' }
      }
      log(`[webSearch] gsk returned 0 results, fallback to Serper`)
    } catch (e) {
      log(`[webSearch] gsk error, fallback to Serper: ${e}`)
    }
  }
  if (serperKey) {
    try {
      log(`[webSearch] trying Serper with query: "${query}"`)
      const resp = await fetchWithTimeout('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'X-API-KEY': serperKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: query, num: maxResults, gl: 'us', hl: 'en' }),
      })
      log(`[webSearch] Serper response status: ${resp.status}`)
      if (resp.ok) {
        const data = asRecord(await resp.json())
        const organic: unknown[] = Array.isArray(data.organic) ? data.organic : []
        log(`[webSearch] Serper organic results: ${organic.length}`)
        const results: WebSearchResult[] = organic.slice(0, maxResults).map((item) => {
          const o = asRecord(item)
          return {
            title: String(o.title ?? ''),
            url: String(o.link ?? ''),
            snippet: String(o.snippet ?? ''),
          }
        })
        const answerBox = asRecord(data.answerBox)
        const answerRaw =
          answerBox.answer || answerBox.snippet || asRecord(data.knowledgeGraph).description
        const answer = typeof answerRaw === 'string' && answerRaw ? answerRaw : undefined
        if (results.length) {
          log(`[webSearch] Serper success, results: ${results.length}`)
          return answer !== undefined
            ? { results, answer, method: 'serper' }
            : { results, method: 'serper' }
        }
        log(`[webSearch] Serper returned 0 results, fallback to DuckDuckGo`)
      }
    } catch (e) {
      log(`[webSearch] Serper error, fallback to DuckDuckGo: ${e}`)
    }
  }
  log(`[webSearch] trying DuckDuckGo with query: "${query}"`)
  const duck = await duckWebSearch(query, maxResults)
  log(`[webSearch] DuckDuckGo results: ${duck.results.length}`)
  return { ...duck, method: 'duckduckgo' }
}

// ── Image search ────────────────────────────────────────────────────

export async function imageSearch(
  query: string,
  maxResults = 8,
): Promise<{
  images: ImageSearchResult[]
  method: string
}> {
  if (hasGskAuth()) {
    try {
      const images = await gskImageSearch(query, maxResults)
      if (images.length) return { images, method: 'gsk' }
    } catch {
      /* fall back to Serper/DuckDuckGo */
    }
  }
  const key = SERPER_KEY()
  if (key) {
    try {
      const resp = await fetchWithTimeout('https://google.serper.dev/images', {
        method: 'POST',
        headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: query, num: Math.min(maxResults, 10), gl: 'us', hl: 'en' }),
      })
      if (resp.ok) {
        const data = asRecord(await resp.json())
        const raw: unknown[] = Array.isArray(data.images) ? data.images : []
        const images: ImageSearchResult[] = []
        for (const item of raw) {
          const img = asRecord(item)
          const imageUrl = String(img.imageUrl ?? img.original ?? '')
          if (!imageUrl) continue
          if (COPYRIGHT_HOSTS.some((d) => imageUrl.toLowerCase().includes(d))) continue
          const entry: ImageSearchResult = {
            title: String(img.title ?? ''),
            imageUrl,
            sourceUrl: String(img.link ?? ''),
            source: String(img.source ?? safeHost(img.link)),
          }
          if (typeof img.imageWidth === 'number') entry.width = img.imageWidth
          if (typeof img.imageHeight === 'number') entry.height = img.imageHeight
          images.push(entry)
          if (images.length >= maxResults) break
        }
        if (images.length) return { images, method: 'serper' }
      }
    } catch {
      /* fall back to DuckDuckGo */
    }
  }
  return { images: await duckImageSearch(query, maxResults), method: 'duckduckgo' }
}

// ── DuckDuckGo fallback (no key / quota exhausted) ──────────────────

async function duckWebSearch(
  query: string,
  maxResults: number,
): Promise<{ results: WebSearchResult[] }> {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
    console.log('[duckWebSearch] fetching:', url)
    const resp = await fetchWithTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    console.log('[duckWebSearch] response status:', resp.status)
    const html = await resp.text()
    console.log('[duckWebSearch] response html length:', html.length)
    const results: WebSearchResult[] = []
    const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
    let m: RegExpExecArray | null
    while ((m = re.exec(html)) !== null && results.length < maxResults) {
      const url = decodeDuckUrl(m[1]!)
      const title = stripTags(m[2]!)
      if (url && title) results.push({ title, url, snippet: '' })
    }
    console.log('[duckWebSearch] parsed results:', results.length)
    return { results }
  } catch (e) {
    console.log('[duckWebSearch] error:', e)
    return { results: [] }
  }
}

async function duckImageSearch(query: string, maxResults: number): Promise<ImageSearchResult[]> {
  try {
    // DuckDuckGo i.js needs a vqd token, so it takes two steps
    const tokenResp = await fetchWithTimeout(
      `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } },
    )
    const tokenHtml = await tokenResp.text()
    const vqd = /vqd=["']?([\d-]+)["']?/.exec(tokenHtml)?.[1]
    if (!vqd) return []
    const resp = await fetchWithTimeout(
      `https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(query)}&vqd=${vqd}`,
      { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://duckduckgo.com/' } },
    )
    const data = asRecord(await resp.json())
    const list: unknown[] = Array.isArray(data.results) ? data.results : []
    const out: ImageSearchResult[] = []
    for (const item of list.slice(0, maxResults)) {
      const img = asRecord(item)
      const imageUrl = String(img.image ?? '')
      if (!imageUrl || COPYRIGHT_HOSTS.some((d) => imageUrl.toLowerCase().includes(d))) continue
      const entry: ImageSearchResult = {
        title: String(img.title ?? ''),
        imageUrl,
        sourceUrl: String(img.url ?? ''),
        source: safeHost(img.url),
      }
      if (typeof img.width === 'number') entry.width = img.width
      if (typeof img.height === 'number') entry.height = img.height
      out.push(entry)
    }
    return out
  } catch {
    return []
  }
}

// ── utils ───────────────────────────────────────────────────────────

/**
 * Resolve the appropriate fetch implementation. In Electron main process,
 * use net.fetch which respects proxy configuration. The EnvHttpProxyAgent
 * automatically handles proxy bypass for local/intranet domains based on
 * system proxy settings (NO_PROXY env var and system proxy bypass rules).
 */
function resolveFetch(): typeof fetch {
  if (process.versions.electron) {
    try {
      const require = createRequire(import.meta.url)
      const { net } = require('electron') as { net?: { fetch?: typeof fetch } }
      if (net?.fetch) return net.fetch.bind(net)
    } catch {
      /* non-main context: keep global fetch */
    }
  }
  return fetch
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), init.timeoutMs ?? 15000)
  try {
    const fetchImpl = resolveFetch()
    return await fetchImpl(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(t)
  }
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .trim()
}

function decodeDuckUrl(href: string): string {
  // DuckDuckGo result links are often /l/?uddg=<encoded>
  const m = /[?&]uddg=([^&]+)/.exec(href)
  if (m) return decodeURIComponent(m[1]!)
  return href.startsWith('http') ? href : ''
}

// ── Web content fetch ───────────────────────────────────────────────

export interface WebFetchResult {
  content: string
  title?: string
  method: string
}

const turndownService = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
})

// Remove script, style, and other non-content elements
turndownService.remove(['script', 'style', 'noscript', 'iframe', 'svg', 'canvas', 'object', 'embed', 'meta', 'link', 'head', 'footer', 'nav'])

// Custom rule to skip text nodes that contain JavaScript code
turndownService.addRule('inlineJavaScript', {
  filter: (node) => {
    // Filter text nodes that contain JavaScript patterns
    return node.nodeType === 3 && // Text node
      /window\.\_|!function|function\s*\([^)]*\)\s*{|var\s+\w+\s*=/.test(node.textContent || '')
  },
  replacement: () => '' // Replace with empty string
})

export async function webFetch(url: string): Promise<WebFetchResult> {
  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  }
  console.log('[webFetch] fetching URL:', url)
  const safeProxyLog = (val: string | undefined) => {
    if (!val) return '(none)'
    try {
      return val.replace(/\/\/[^@/]*@/, '//***@')
    } catch {
      return '(invalid)'
    }
  }
  console.log('[webFetch] proxy env vars:', {
    HTTPS_PROXY: safeProxyLog(process.env.HTTPS_PROXY),
    HTTP_PROXY: safeProxyLog(process.env.HTTP_PROXY),
    NO_PROXY: process.env.NO_PROXY || '(none)'
  })
  
  // For intranet domains (.home, .local, .internal), use global fetch directly (bypasses SSRF guard and proxy)
  const isIntranetDomain = ['.home', '.local', '.internal'].some(suffix => url.toLowerCase().includes(suffix))
  console.log('[webFetch] is intranet domain:', isIntranetDomain)
  
  try {
    // For intranet domains, use Node.js native http/https module (bypasses proxy, works reliably)
    if (isIntranetDomain) {
      console.log('[webFetch] Using native http for intranet domain (bypasses proxy)')
      return await fetchWithNativeHttp(url)
    }
    
    const fetchImpl = resolveFetch()
    console.log('[webFetch] Using net.fetch for public domain')
    
    // Try the original URL first
    console.log('[webFetch] Attempting fetch with SSRF guard:', url)
    let resp = await fetchWithSsrfGuard(url, { headers, fetchImpl })
    console.log('[webFetch] SSRF guard result:', resp ? `success (${resp.status})` : 'null (blocked or failed)')
    
    // If HTTP fails and the URL doesn't already use HTTPS, try HTTPS
    if (!resp && url.startsWith('http://')) {
      const httpsUrl = url.replace('http://', 'https://')
      console.log('[webFetch] HTTP failed, trying HTTPS:', httpsUrl)
      resp = await fetchWithSsrfGuard(httpsUrl, { headers, fetchImpl })
      console.log('[webFetch] HTTPS attempt result:', resp ? `success (${resp.status})` : 'null (blocked or failed)')
    }
    
    if (!resp) {
      const errorMsg = `[webFetch] fetchWithSsrfGuard returned null for: ${url}. This means either: (1) DNS resolution failed, (2) SSRF guard blocked the URL (private/internal IP), or (3) the host is in the blocked list (.localhost, etc.). Check proxy settings and NO_PROXY env var for intranet sites.`
      console.log(errorMsg)
      throw new Error(`Failed to fetch ${url}: Connection failed - DNS resolution or SSRF guard blocked the request. For intranet sites, ensure NO_PROXY includes the domain.`);
    }
    if (!resp.ok) {
      console.log('[webFetch] response not ok:', resp.status, resp.statusText)
      throw new Error(`Failed to fetch ${url}: HTTP ${resp.status} ${resp.statusText}`)
    }
    console.log('[webFetch] response status:', resp.status)
    const html = await resp.text()
    
    // Use cheerio to properly parse and clean HTML before converting to markdown
    const $ = cheerio.load(html)
    
    // Remove all script, style, and non-content elements
    $('script, style, noscript, iframe, svg, canvas, object, embed, meta, link, head, footer, nav').remove()
    
    // Get cleaned HTML
    const cleanedHtml = $.html()
    
    // Convert to markdown
    let markdown = turndownService.turndown(cleanedHtml)
    
    // Post-process markdown to remove inline JavaScript that WordPress outputs as text
    // This handles malformed HTML where JS appears outside of script tags
    // Aggressively remove any JavaScript patterns
    markdown = markdown.replace(/window\.[\s\S]{0,4000}?}\([^)]*\)\s*/g, '')
    
    // Extract title from original HTML
    const title = $('title').text().trim() || undefined
    
    const content = markdown.trim() || '(no content)'
    console.log('[webFetch] returning result with method=fetch, content length:', content.length)
    return { content, title, method: 'fetch' }
  } catch (err) {
    const errorMsg = err && typeof err === 'object' && 'message' in err ? String(err.message) : String(err)
    console.log('[webFetch] error:', errorMsg)
    throw new Error(errorMsg)
  }
}

// Fetch using native Node.js http/https (bypasses proxy, works for intranet)
async function fetchWithNativeHttp(url: string): Promise<WebFetchResult> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url)
    const lib = parsedUrl.protocol === 'https:' ? httpsRequest : get
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      agent: false, // Explicitly bypass proxy
      timeout: 15000,
    }
    
    const req = lib(options, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          // Use cheerio to properly parse and clean HTML
          const $ = cheerio.load(data)
          $('script, style, noscript, iframe, svg, canvas, object, embed, meta, link, head, footer, nav').remove()
          const cleanedHtml = $.html()
          const markdown = turndownService.turndown(cleanedHtml)
          const title = $('title').text().trim() || undefined
          const content = markdown.trim() || '(no content)'
          resolve({
            content,
            title,
            method: 'native-http'
          })
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`))
        }
      })
    })
    
    req.on('error', (err) => {
      reject(err)
    })
    
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('Request timeout'))
    })
    
    req.end()
  })
}
