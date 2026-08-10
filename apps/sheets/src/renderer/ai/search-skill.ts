import type { AgentSkill } from '@genoffice/agent-core'
import { t } from '../i18n/locale'

/**
 * Web-search AgentSkill (same source as docs/slides web_search):
 * the main process queries Serper/DuckDuckGo; the renderer only receives
 * titles/links/snippets.
 */

const SEARCH_SYSTEM_PROMPT = `## Web search and fetch
- When you need up-to-date information, data, or facts beyond the workbook, use web_search; never fabricate numbers from memory.
- When you need the full content of a specific URL (articles/docs/tutorials), use web_fetch to fetch and convert to markdown.
- When writing search results into the workbook, you must attribute the data source (load_guide: data-attribution first).`

export function createSearchSkill(): AgentSkill {
  return {
    id: 'search',
    systemPrompt: SEARCH_SYSTEM_PROMPT,
    tools: [
      {
        name: 'web_search',
        description:
          'Search the web for textual information (references/data/facts). Use when you need up-to-date information or are unsure about a fact. Returns titles/links/snippets.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search keywords' },
            maxResults: { type: 'integer', description: 'Maximum number of results, default 6' },
          },
          required: ['query'],
        },
      },
      {
        name: 'web_fetch',
        description:
          'Fetch a web page and convert to markdown. Use when you need the full content of a specific URL (articles/docs/tutorials). Returns markdown content and page title.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'URL to fetch' },
          },
          required: ['url'],
        },
      },
    ],
    executeTool: async (call) => {
      if (call.name === 'web_search') {
        const query = String(call.input.query ?? '').trim()
        if (!query) {
          return { output: 'query must not be empty', isError: true, summary: t('aiToolWebSearch') }
        }
        const r = await window.desktopApi.webSearch(query, Number(call.input.maxResults) || 6)
        const lines: string[] = []
        if (r.answer) lines.push(`Direct answer: ${r.answer}\n`)
        r.results.forEach((it, i) =>
          lines.push(`${i + 1}. ${it.title}\n   ${it.url}\n   ${it.snippet}`),
        )
        return {
          output: lines.join('\n') || '(no results)',
          mutated: false,
          summary: t('aiToolWebSearchDone', { query, count: r.results.length }),
        }
      }
      if (call.name === 'web_fetch') {
        const url = String(call.input.url ?? '').trim()
        if (!url) {
          return { output: 'url must not be empty', isError: true, summary: t('aiToolWebFetch') }
        }
        try {
          const r = await window.desktopApi.webFetch(url)
          if (r.method === 'error') {
            return {
              output: `web fetch failed: ${r.error ?? 'unknown error'}`,
              isError: true,
              summary: t('aiSumWebFetch'),
            }
          }
          const content = String(r.content || '')
          if (!content) {
            return {
              output: `web fetch returned empty content (method: ${r.method})`,
              isError: true,
              summary: t('aiSumWebFetch'),
            }
          }
          const lines: string[] = []
          if (r.title) lines.push(`Title: ${r.title}\n`)
          lines.push(`URL: ${url}\n`)
          lines.push(`Content:\n${content}`)
          return {
            output: lines.join('\n'),
            mutated: false,
            summary: t('aiSumWebFetchDone', { url }),
          }
        } catch (err) {
          return {
            output: `web fetch error: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
            summary: t('aiSumWebFetch'),
          }
        }
      }
      return { output: `Unknown tool: ${call.name}`, isError: true, summary: call.name }
    },
  }
}
