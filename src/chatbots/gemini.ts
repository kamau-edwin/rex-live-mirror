/**
 * Google Gemini Parser
 * Extracts Q&A pairs from Google Gemini interface
 */

export interface ParsedInteraction {
  type: 'question' | 'response'
  content: string
}

export interface GeminiSelectors {
  userMessage?: string
  assistantMessage?: string
}

export interface GeminiConfig {
  enabled?: boolean
  selectors?: GeminiSelectors
}

export interface ExtractedSource {
  source_title: string
  source_url?: string
}

export class GeminiParser {
  name = 'gemini'
  selectors: GeminiSelectors

  constructor(config?: GeminiConfig) {
    // Use config selectors or defaults
    this.selectors = config?.selectors || {
      userMessage: '[data-text-user-message]',
      assistantMessage: '[data-text-assistant-message]',
    }
    console.log('[GeminiParser] Initialized with selectors:', this.selectors)
  }

  private normalizeQuestion(content: string): string {
    // Gemini often prepends screen-reader text like "You said" to user prompts.
    return content.replace(/^\s*you\s+said\s*/i, '').replace(/\s+/g, ' ').trim()
  }

  extractInteractions(): ParsedInteraction[] {
    const interactions: ParsedInteraction[] = []

    // Find user messages using config selector
    if (this.selectors.userMessage) {
      const userMessages = document.querySelectorAll(this.selectors.userMessage)
      console.log(`[GeminiParser] Found ${userMessages.length} user message elements`)
      userMessages.forEach((msg) => {
        const rawContent = msg.textContent?.trim()
        const content = rawContent ? this.normalizeQuestion(rawContent) : undefined
        if (content) {
          interactions.push({
            type: 'question',
            content,
          })
        }
      })
    }

    // Find assistant messages using config selector
    if (this.selectors.assistantMessage) {
      const assistantMessages = document.querySelectorAll(this.selectors.assistantMessage)
      console.log(`[GeminiParser] Found ${assistantMessages.length} assistant message elements`)
      assistantMessages.forEach((msg) => {
        const content = msg.textContent?.trim()
        if (content) {
          interactions.push({
            type: 'response',
            content,
          })
        }
      })
    }

    return interactions
  }

  isResponseComplete(): boolean {
    const responseContainers = document.querySelectorAll('.conversation-container model-response')
    if (responseContainers.length === 0) {
      return false
    }

    const latest = responseContainers[responseContainers.length - 1]
    const hasCompleteFooter = latest.querySelector('.response-footer.gap.complete') !== null
    const hasCopyAction = latest.querySelector('message-actions button[data-test-id="copy-button"]') !== null
    const isBusy = latest.querySelector('.markdown.markdown-main-panel[aria-busy="true"]') !== null

    if (hasCompleteFooter) {
      return true
    }

    return hasCopyAction && !isBusy
  }

  extractSources(): ExtractedSource[] {
    const sources: ExtractedSource[] = []
    const seen = new Set<string>()

    const addSource = (source_title?: string, source_url?: string): void => {
      const cleanTitle = source_title?.trim()
      const cleanUrl = source_url?.trim()
      if (!cleanTitle && !cleanUrl) {
        return
      }

      const key = `${cleanTitle || ''}|${cleanUrl || ''}`
      if (seen.has(key)) {
        return
      }

      seen.add(key)
      sources.push({
        source_title: cleanTitle || cleanUrl || 'source',
        source_url: cleanUrl,
      })
    }

    // Prefer explicit source links when present.
    const sourceAnchors = document.querySelectorAll('.conversation-container model-response a[href^="http"]')
    sourceAnchors.forEach((anchor) => {
      const url = anchor.getAttribute('href') || undefined
      if (!url || url.includes('gemini.google.com')) {
        return
      }

      const title = anchor.textContent?.replace(/\s+/g, ' ').trim() || anchor.getAttribute('aria-label') || undefined
      addSource(title, url)
    })

    // Fallback: capture source chip labels even when URL is not directly exposed.
    const sourceButtons = document.querySelectorAll(
      '.conversation-container model-response sources-list button, .conversation-container model-response source-inline-chip button',
    )
    sourceButtons.forEach((button, index) => {
      const text = button.textContent?.replace(/\s+/g, ' ').trim() || ''
      const aria = button.getAttribute('aria-label')?.trim() || ''
      const label = text || aria || `source-${index + 1}`
      addSource(label)
    })

    console.log(`[GeminiParser] Extracted ${sources.length} sources`)
    return sources
  }
}
