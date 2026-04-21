/**
 * ChatGPT Parser
 * Extracts Q&A pairs from ChatGPT interface
 */

export interface ParsedInteraction {
  type: 'question' | 'response'
  content: string
}

export interface ChatGPTSelectors {
  userMessage?: string
  assistantMessage?: string
  messageContainer?: string
  contentDiv?: string
  citationElements?: string
  loginButton?: string
  profileButton?: string
  conversationId?: string
  conversationTurnFallback?: string
  assistantContent?: string
  stopGeneratingButton?: string
  writingBlock?: string
  streamActive?: string
  assistantTurnContainer?: string
  copyResponseButton?: string
}

export interface ExtractedSource {
  source_title: string
  source_url?: string
}

export interface ChatGPTConfig {
  enabled?: boolean
  selectors?: ChatGPTSelectors
}

export class ChatGPTParser {
  name = 'chatgpt'
  selectors: ChatGPTSelectors
  private lastResponseSnapshot = ''
  private stableResponseChecks = 0

  constructor(config?: ChatGPTConfig) {
    this.selectors = config?.selectors || {
      userMessage: '[data-message-author-role="user"]',
      assistantMessage: '[data-message-author-role="assistant"]',
    }
    console.log('[ChatGPTParser] Initialized with selectors:', this.selectors)
  }

  extractInteractions(): ParsedInteraction[] {
    const interactions: ParsedInteraction[] = []
    const assistantContentSelector = this.selectors.assistantContent || '.markdown.prose, .markdown'

    if (this.selectors.userMessage) {
      const userMessages = document.querySelectorAll(this.selectors.userMessage)
      console.log(`[ChatGPTParser] Found ${userMessages.length} user message elements`)
      userMessages.forEach((msg) => {
        const content = msg.textContent?.trim()
        if (content && content.length > 0) {
          interactions.push({
            type: 'question',
            content,
          })
        }
      })
    }

    if (this.selectors.assistantMessage) {
      const assistantMessageContainers = document.querySelectorAll(this.selectors.assistantMessage)
      console.log(`[ChatGPTParser] Found ${assistantMessageContainers.length} assistant message elements`)

      assistantMessageContainers.forEach((container) => {
        const proseElement = container.querySelector(assistantContentSelector)
        const content = proseElement?.textContent?.trim() || container.textContent?.trim() || null

        if (content && content.length > 0) {
          interactions.push({
            type: 'response',
            content,
          })
        }
      })
    }

    if (interactions.length === 0) {
      const conversationTurnFallback = this.selectors.conversationTurnFallback || '[data-testid="conversation-turn"]'
      console.log(`[ChatGPTParser] No messages found with primary selectors, trying fallback ${conversationTurnFallback}`)
      const messageGroups = document.querySelectorAll(conversationTurnFallback)
      console.log(`[ChatGPTParser] Found ${messageGroups.length} conversation-turn elements`)
      messageGroups.forEach((group) => {
        const textContent = group.textContent?.trim()
        if (textContent && textContent.length > 0) {
          interactions.push({
            type: interactions.length % 2 === 0 ? 'question' : 'response',
            content: textContent,
          })
        }
      })
    }

    return interactions
  }

  isResponseComplete(): boolean {
    const stopGeneratingSelector = this.selectors.stopGeneratingButton || 'button[aria-label="Stop generating"]'
    const assistantSelector = this.selectors.assistantMessage || '[data-message-author-role="assistant"]'
    const assistantContentSelector = this.selectors.assistantContent || '.markdown.prose, .markdown'
    const writingBlockSelector = this.selectors.writingBlock || '[data-writing-block]'
    const streamActiveSelector = this.selectors.streamActive || '[data-stream-active="true"], [data-is-streaming="true"]'
    const assistantTurnSelector = this.selectors.assistantTurnContainer || 'section[data-turn="assistant"]:last-of-type, [data-testid^="conversation-turn-"][data-turn="assistant"]:last-of-type'
    const copyResponseSelector = this.selectors.copyResponseButton || 'div[aria-label="Response actions"] [data-testid="copy-turn-action-button"], div[aria-label="Response actions"] button[aria-label="Copy response"]'

    const getLastMatchedElement = (selector: string): Element | null => {
      const matches = document.querySelectorAll(selector)
      return matches.length > 0 ? matches[matches.length - 1] : null
    }

    if (document.querySelector(stopGeneratingSelector)) {
      console.log('[ChatGPTParser] Response still streaming - stop generating button detected')
      return false
    }

    const latestAssistantMsg = getLastMatchedElement(assistantSelector)
    if (latestAssistantMsg?.getAttribute('aria-busy') === 'true') {
      console.log('[ChatGPTParser] Response still streaming - aria-busy="true" detected')
      return false
    }

    if (document.querySelector(writingBlockSelector)) {
      console.log('[ChatGPTParser] Response still streaming - writing block detected')
      return false
    }

    if (document.querySelector(streamActiveSelector)) {
      console.log('[ChatGPTParser] Response still streaming - stream active marker detected')
      return false
    }

    const latestMarkdown = latestAssistantMsg?.querySelector(assistantContentSelector)
    const latestContent = (latestMarkdown?.textContent || latestAssistantMsg?.textContent || '').trim()
    const latestAssistantTurn = document.querySelector(assistantTurnSelector)
    const hasCopyResponseButton = !!latestAssistantTurn?.querySelector(copyResponseSelector)

    if (!latestContent) {
      console.log('[ChatGPTParser] Response incomplete - empty assistant content')
      return false
    }

    if (!hasCopyResponseButton) {
      console.log('[ChatGPTParser] Response incomplete - response actions copy button not available yet')
      return false
    }

    if (latestContent === this.lastResponseSnapshot) {
      this.stableResponseChecks += 1
    } else {
      this.lastResponseSnapshot = latestContent
      this.stableResponseChecks = 0
      console.log('[ChatGPTParser] Response changed - waiting for stability before capture')
      return false
    }

    if (this.stableResponseChecks < 1) {
      console.log('[ChatGPTParser] Waiting one extra poll for response stability')
      return false
    }

    if (/\n\s*\d+\.\s*$/.test(latestContent)) {
      console.log('[ChatGPTParser] Response appears truncated at list marker, waiting for continuation')
      return false
    }

    console.log('[ChatGPTParser] Response appears complete')
    return true
  }

  extractSources(): ExtractedSource[] {
    const sources: ExtractedSource[] = []
    const visitedUrls = new Set<string>()

    const normalizeSourceUrl = (rawUrl: string | null): string | undefined => {
      if (!rawUrl) return undefined

      let candidate = rawUrl.trim()
      if (!candidate) return undefined

      try {
        if (candidate.startsWith('/')) {
          candidate = new URL(candidate, window.location.origin).toString()
        }

        const parsed = new URL(candidate)
        const redirectTarget =
          parsed.searchParams.get('url') ||
          parsed.searchParams.get('q') ||
          parsed.searchParams.get('target') ||
          parsed.searchParams.get('redirect') ||
          parsed.searchParams.get('redirect_uri')

        if (redirectTarget) {
          try {
            const decoded = decodeURIComponent(redirectTarget)
            if (/^https?:\/\//i.test(decoded)) {
              return decoded
            }
          } catch {
            if (/^https?:\/\//i.test(redirectTarget)) {
              return redirectTarget
            }
          }
        }

        return parsed.toString()
      } catch {
        return /^https?:\/\//i.test(candidate) ? candidate : undefined
      }
    }

    const shouldSkipUrl = (url: string): boolean => {
      if (!url) return true
      if (url.startsWith('#') || url.startsWith('javascript:')) return true
      if (url.startsWith('/')) return true
      try {
        const hostname = new URL(url).hostname
        if (hostname.includes('chatgpt.com') || hostname.includes('openai.com')) return true
      } catch {
        return true
      }
      if (visitedUrls.has(url)) return true
      return false
    }

    const isValidTitle = (title: string): boolean => {
      if (!title || title.length < 3) return false
      const skipPatterns = [
        /^skip\s+to/i,
        /^jump\s+to/i,
        /^go\s+to/i,
        /^main\s+content/i,
        /^navigation/i,
        /^\d+$/,
      ]
      return !skipPatterns.some((pattern) => pattern.test(title))
    }

    const linkSelector = this.selectors.citationElements || '[data-message-author-role="assistant"] a[href], .group\\/nav-list a[href], button.group\\/footnote a[href]'
    const linkElements = document.querySelectorAll(linkSelector)

    linkElements.forEach((element) => {
      const url = normalizeSourceUrl(element.getAttribute('href'))
      if (!url || shouldSkipUrl(url)) return

      let title: string | undefined = element.textContent?.trim()
      if (title) {
        title = title.replace(/\s+/g, ' ').substring(0, 200)
      }
      if (!title) {
        title = element.getAttribute('title') || element.getAttribute('aria-label') || undefined
      }

      if (!title || !isValidTitle(title) || title.startsWith('http')) {
        try {
          title = new URL(url).hostname.replace(/^www\./, '')
        } catch {
          title = url
        }
      }

      visitedUrls.add(url)
      sources.push({ source_title: title, source_url: url })
    })

    const assistantMessages = document.querySelectorAll(
      this.selectors.assistantMessage || '[data-message-author-role="assistant"]',
    )
    const urlRegex = /https?:\/\/[^\s<>"{}|\\^`[\]]+/g

    assistantMessages.forEach((msg) => {
      const textContent = msg.textContent || ''
      const matches = textContent.match(urlRegex)

      if (matches) {
        matches.forEach((url) => {
          const cleanUrl = url.replace(/[.,;:!?)]+$/, '')
          if (shouldSkipUrl(cleanUrl)) return

          visitedUrls.add(cleanUrl)
          try {
            const domain = new URL(cleanUrl).hostname.replace(/^www\./, '')
            sources.push({ source_title: domain, source_url: cleanUrl })
          } catch {
            sources.push({ source_title: cleanUrl, source_url: cleanUrl })
          }
        })
      }
    })

    console.log(`[ChatGPTParser] Extracted ${sources.length} sources`)
    return sources
  }
}
