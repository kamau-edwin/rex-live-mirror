/**
 * ChatGPT Parser
 * Extracts Q&A pairs from ChatGPT interface
 */

export interface ParsedInteraction {
  type: 'question' | 'response'
  content: string
}

export interface ChatGPTSelectors {
  userMessage: string
  assistantMessage: string
  conversationTurnFallback: string
  assistantContent: string
  stopGeneratingButton: string
  writingBlock: string
  streamActive: string
  assistantTurnContainer: string
  copyResponseButton: string
  citationElements: string
}

export type ChatGPTSelectorFallbacks = Partial<Record<keyof ChatGPTSelectors, string[]>>

export type ChatGPTFallbackMode = 'append' | 'replace' | 'none'

export interface ExtractedSource {
  source_title: string
  source_url?: string
}

export interface ChatGPTConfig {
  enabled?: boolean
  selectors?: ChatGPTSelectors
  fallback_mode?: ChatGPTFallbackMode
  selector_fallbacks?: ChatGPTSelectorFallbacks
}

export interface ChatGPTCompletionDecision {
  completed: boolean
  reason:
    | 'complete'
    | 'selector_validation_failed'
    | 'streaming'
    | 'empty_assistant_content'
    | 'copy_button_missing'
    | 'stability_pending'
    | 'truncated_marker'
  shouldRecheck: boolean
  recheckDelayMs?: number
}

export class ChatGPTParser {
  name = 'chatgpt'
  selectors: ChatGPTSelectors
  private fallbackMode: ChatGPTFallbackMode
  private selectorFallbacks: ChatGPTSelectorFallbacks
  private lastResponseSnapshot = ''
  private stableResponseChecks = 0
  private selectorValidationError: string | null = null

  constructor(config?: ChatGPTConfig) {
    this.selectors = config?.selectors as ChatGPTSelectors || ({} as ChatGPTSelectors)
    this.fallbackMode = config?.fallback_mode || 'append'
    this.selectorFallbacks = config?.selector_fallbacks || {}
    
    // STRICT MODE: Validate all required selectors are present
    const required: (keyof ChatGPTSelectors)[] = [
      'userMessage',
      'assistantMessage',
      'assistantContent',
      'conversationTurnFallback',
      'stopGeneratingButton',
      'writingBlock',
      'streamActive',
      'assistantTurnContainer',
      'copyResponseButton',
      'citationElements'
    ]
    
    const missing = required.filter((key) => {
      const primary = this.selectors[key]
      const fallbacks = this.selectorFallbacks[key] || []
      return !primary && fallbacks.filter(Boolean).length === 0
    })
    if (missing.length > 0) {
      this.selectorValidationError = `Missing required selectors: ${missing.join(', ')}`
      console.error(`[ChatGPTParser] ${this.selectorValidationError}`)
      this.reportConfigValidationFailure(this.selectorValidationError)
    }
    
    console.log('[ChatGPTParser] Initialized with config selectors and fallback settings', {
      selectors: this.selectors,
      fallback_mode: this.fallbackMode,
      selector_fallbacks: this.selectorFallbacks,
    })
  }

  private normalizeSelectorUnion(selector?: string): string | undefined {
    if (!selector) {
      return undefined
    }

    const uniqueParts: string[] = []
    const seen = new Set<string>()
    for (const rawPart of selector.split(',')) {
      const part = rawPart.trim()
      if (!part || seen.has(part)) {
        continue
      }
      seen.add(part)
      uniqueParts.push(part)
    }

    return uniqueParts.length > 0 ? uniqueParts.join(', ') : undefined
  }

  private resolveSelector<K extends keyof ChatGPTSelectors>(key: K): string | undefined {
    const primary = this.normalizeSelectorUnion(this.selectors[key])
    const fallbacks = (this.selectorFallbacks[key] || []).map((s) => s.trim()).filter(Boolean)

    if (this.fallbackMode === 'none') {
      return primary || undefined
    }

    if (this.fallbackMode === 'append') {
      const selectorGroups = Array.from(new Set([primary, ...fallbacks].filter(Boolean) as string[]))
      const parts = selectorGroups.reduce<string[]>((acc, selector) => {
        const normalized = selector
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean)
        acc.push(...normalized)
        return acc
      }, [])
      const uniqueParts = Array.from(new Set(parts))
      return uniqueParts.length > 0 ? uniqueParts.join(', ') : undefined
    }

    // replace mode: choose first selector that currently matches DOM
    const candidates = [primary, ...fallbacks].filter(Boolean) as string[]
    for (const selector of candidates) {
      try {
        if (document.querySelector(selector)) {
          return selector
        }
      } catch {
        // Ignore invalid selectors and try next candidate.
      }
    }

    return primary || fallbacks[0]
  }

  private reportConfigValidationFailure(error: string): void {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(chrome.runtime.sendMessage as any)({
        messageType: 'llmConfigValidationFailure',
        payload: {
          source: 'chatgpt',
          error,
          timestamp: Date.now(),
          url: window.location.href,
          selectors: this.selectors
        }
      })
    } catch (e) {
      console.error('[ChatGPTParser] Failed to report config failure:', e)
    }
  }

  extractInteractions(): ParsedInteraction[] {
    if (this.selectorValidationError) {
      console.error('[ChatGPTParser] Cannot extract - selector validation failed:', this.selectorValidationError)
      return []
    }

    const interactions: ParsedInteraction[] = []
    const userMessageSelector = this.resolveSelector('userMessage')
    const assistantMessageSelector = this.resolveSelector('assistantMessage')
    const assistantContentSelector = this.resolveSelector('assistantContent')
    const conversationTurnSelector = this.resolveSelector('conversationTurnFallback')

    if (userMessageSelector) {
      const userMessages = document.querySelectorAll(userMessageSelector)
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

    if (assistantMessageSelector) {
      const assistantMessageContainers = document.querySelectorAll(assistantMessageSelector)
      console.log(`[ChatGPTParser] Found ${assistantMessageContainers.length} assistant message elements`)

      assistantMessageContainers.forEach((container) => {
        const proseElement = assistantContentSelector ? container.querySelector(assistantContentSelector) : null
        const content = proseElement?.textContent?.trim() || container.textContent?.trim() || null

        if (content && content.length > 0) {
          interactions.push({
            type: 'response',
            content,
          })
        }
      })
    }

    if (interactions.length === 0 && conversationTurnSelector) {
      console.log(`[ChatGPTParser] No messages found with primary selectors, trying fallback ${conversationTurnSelector}`)
      const messageGroups = document.querySelectorAll(conversationTurnSelector)
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

  getCompletionDecision(): ChatGPTCompletionDecision {
    if (this.selectorValidationError) {
      console.error('[ChatGPTParser] Cannot validate completion - selector validation failed:', this.selectorValidationError)
      return {
        completed: false,
        reason: 'selector_validation_failed',
        shouldRecheck: false,
      }
    }

    const stopGeneratingSelector = this.resolveSelector('stopGeneratingButton')
    const assistantSelector = this.resolveSelector('assistantMessage')
    const assistantContentSelector = this.resolveSelector('assistantContent')
    const writingBlockSelector = this.resolveSelector('writingBlock')
    const streamActiveSelector = this.resolveSelector('streamActive')
    const assistantTurnSelector = this.resolveSelector('assistantTurnContainer')
    const copyResponseSelector = this.resolveSelector('copyResponseButton')

    if (!assistantSelector || !assistantContentSelector || !assistantTurnSelector || !copyResponseSelector) {
      return {
        completed: false,
        reason: 'selector_validation_failed',
        shouldRecheck: false,
      }
    }

    const getLastMatchedElement = (selector: string): Element | null => {
      const matches = document.querySelectorAll(selector)
      return matches.length > 0 ? matches[matches.length - 1] : null
    }

    if (stopGeneratingSelector && document.querySelector(stopGeneratingSelector)) {
      console.log('[ChatGPTParser] Response still streaming - stop generating button detected')
      return {
        completed: false,
        reason: 'streaming',
        shouldRecheck: true,
      }
    }

    const latestAssistantMsg = getLastMatchedElement(assistantSelector)
    if (latestAssistantMsg?.getAttribute('aria-busy') === 'true') {
      console.log('[ChatGPTParser] Response still streaming - aria-busy="true" detected')
      return {
        completed: false,
        reason: 'streaming',
        shouldRecheck: true,
      }
    }

    if (writingBlockSelector && document.querySelector(writingBlockSelector)) {
      console.log('[ChatGPTParser] Response still streaming - writing block detected')
      return {
        completed: false,
        reason: 'streaming',
        shouldRecheck: true,
      }
    }

    if (streamActiveSelector && document.querySelector(streamActiveSelector)) {
      console.log('[ChatGPTParser] Response still streaming - stream active marker detected')
      return {
        completed: false,
        reason: 'streaming',
        shouldRecheck: true,
      }
    }

    const latestMarkdown = latestAssistantMsg?.querySelector(assistantContentSelector)
    const latestContent = (latestMarkdown?.textContent || latestAssistantMsg?.textContent || '').trim()
    const latestAssistantTurn = getLastMatchedElement(assistantTurnSelector)
    const hasCopyResponseButton = !!latestAssistantTurn?.querySelector(copyResponseSelector)

    if (!latestContent) {
      console.log('[ChatGPTParser] Response incomplete - empty assistant content')
      return {
        completed: false,
        reason: 'empty_assistant_content',
        shouldRecheck: true,
      }
    }

    // MANDATORY: Copy button MUST appear on the latest turn - hard completion signal
    if (!hasCopyResponseButton) {
      console.log('[ChatGPTParser] Response incomplete - copy button not found on latest turn (awaiting completion)')
      return {
        completed: false,
        reason: 'copy_button_missing',
        shouldRecheck: false,
      }
    }

    // Track response stability: ensure content isn't still being streamed/mutated
    if (latestContent === this.lastResponseSnapshot) {
      this.stableResponseChecks += 1
    } else {
      this.lastResponseSnapshot = latestContent
      this.stableResponseChecks = 0
      console.log('[ChatGPTParser] Response changed - waiting for stability before capture')
      return {
        completed: false,
        reason: 'stability_pending',
        shouldRecheck: true,
      }
    }

    if (this.stableResponseChecks < 1) {
      console.log('[ChatGPTParser] Waiting one extra poll for response stability')
      return {
        completed: false,
        reason: 'stability_pending',
        shouldRecheck: true,
      }
    }

    if (/\n\s*\d+\.\s*$/.test(latestContent)) {
      console.log('[ChatGPTParser] Response appears truncated at list marker, waiting for continuation')
      return {
        completed: false,
        reason: 'truncated_marker',
        shouldRecheck: true,
      }
    }

    console.log('[ChatGPTParser] Response appears complete')
    return {
      completed: true,
      reason: 'complete',
      shouldRecheck: false,
    }
  }

  isResponseComplete(): boolean {
    return this.getCompletionDecision().completed
  }

  extractSources(): ExtractedSource[] {
    if (this.selectorValidationError) {
      console.error('[ChatGPTParser] Cannot extract sources - selector validation failed:', this.selectorValidationError)
      return []
    }

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

    const linkSelector = this.resolveSelector('citationElements')
    if (!linkSelector) {
      return []
    }
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

    const assistantSelector = this.resolveSelector('assistantMessage')
    const assistantMessages: Element[] = assistantSelector
      ? Array.from(document.querySelectorAll(assistantSelector))
      : []
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
