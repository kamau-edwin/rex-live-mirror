/**
 * Google Gemini Parser
 * Extracts Q&A pairs from Google Gemini interface
 */

export interface ParsedInteraction {
  type: 'question' | 'response'
  content: string
  question_timestamp?: number
}

export interface GeminiSelectors {
  userMessage?: string
  assistantMessage?: string
  responseContainer?: string
  completeFooter?: string
  copyAction?: string
  busyIndicator?: string
  sourceAnchors?: string
  sourceButtons?: string
  sourceDetailAnchors?: string
  sourceToggleButton?: string
  sourceCloseButton?: string
  sourceMenuButton?: string
  sourceMenuItem?: string
}

/**
 * Per-selector fallback arrays. Keys match GeminiSelectors keys.
 * Used to try alternative selectors when the primary selector yields no results.
 */
export type GeminiSelectorFallbacks = Partial<Record<keyof GeminiSelectors, string[]>>

/**
 * Controls how primary selectors are merged with their fallbacks:
 *   append  — "primary, fallback1, fallback2"  (CSS union, default)
 *   replace — first selector (primary or fallback) that matches the DOM wins
 *   none    — only the primary selector is used; fallbacks are ignored
 */
export type GeminiFallbackMode = 'append' | 'replace' | 'none'

export interface GeminiConfig {
  enabled?: boolean
  selectors?: GeminiSelectors
  fallback_mode?: GeminiFallbackMode
  selector_fallbacks?: GeminiSelectorFallbacks
}

export interface ExtractedSource {
  source_title: string
  source_url?: string
}

export interface ExtractedSourceGroup {
  domain_title: string
  domain_name: string
  sources: ExtractedSource[]
}

export type GeminiSourceExtractionClassification =
  | 'success'
  | 'none'
  | 'terminal_empty'
  | 'data_capture_error'
  | 'panel_opening_failure'

export class GeminiParser {
  name = 'gemini'
  selectors: GeminiSelectors
  private fallbackMode: GeminiFallbackMode
  private selectorFallbacks: GeminiSelectorFallbacks
  private extractedResponseIds = new Set<string>()
  private loggedCompletedSkipResponseIds = new Set<string>()
  private panelOpenedByParserForResponseId: string | undefined = undefined
  private selectorValidationError: string | null = null
  private responseContainerIds = new Map<Element, string>()
  private responseContainerSequence = 0
  private sourceExtractionStatusByResponseId = new Map<string, GeminiSourceExtractionClassification>()
  // Keyed by "normalizedContent:index" so that DOM remounts of the same question
  // return the same timestamp, while a genuinely new identical question at a
  // different position in the conversation gets a distinct timestamp.
  private questionTimestampsByContentIndex = new Map<string, number>()
  private lastAssignedQuestionTimestamp = 0

  constructor(config?: GeminiConfig) {
    // Config-only selectors: missing values are handled with warnings at call sites.
    this.selectors = config?.selectors || {}
    this.fallbackMode = config?.fallback_mode || 'append'
    this.selectorFallbacks = config?.selector_fallbacks || {}
    
    // STRICT MODE: Validate required selectors are present
    const required: (keyof GeminiSelectors)[] = [
      'userMessage',
      'assistantMessage',
      'responseContainer',
      'completeFooter'
    ]
    
    const missing = required.filter(key => !this.selectors[key])
    if (missing.length > 0) {
      this.selectorValidationError = `Missing required selectors: ${missing.join(', ')}`
      console.error(`[GeminiParser] ${this.selectorValidationError}`)
      this.reportConfigValidationFailure(this.selectorValidationError)
    }
    
    console.log('[GeminiParser] Initialized with selectors:', this.selectors)
  }

  private reportConfigValidationFailure(error: string): void {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(chrome.runtime.sendMessage as any)({
        messageType: 'llmConfigValidationFailure',
        payload: {
          source: 'gemini',
          error,
          timestamp: Date.now(),
          url: window.location.href,
          selectors: this.selectors
        }
      })
    } catch (e) {
      console.error('[GeminiParser] Failed to report config failure:', e)
    }
  }

  /**
   * Strip the domain + snippet text that Gemini appends to source card titles.
   * Gemini chip textContent is typically: "SiteName domain.com Page title excerpt..."
   * When a URL is available we locate its hostname in the title and take only what precedes it.
   */
  private stripSnippetFromTitle(title: string, url?: string): string {
    if (!title) return title

    // Use URL hostname as anchor: take everything before it
    if (url) {
      try {
        const hostname = new URL(url).hostname
        const hostIdx = title.indexOf(hostname)
        if (hostIdx > 0) {
          const beforeHost = title.substring(0, hostIdx).trim()
          if (beforeHost) return beforeHost
        }
      } catch {
        // fall through
      }
    }

    // Fallback: strip from the first domain-like token onward
    // e.g. "Wikipedia en.wikipedia.org Politics..." → "Wikipedia"
    const domainBoundary = title.match(/^(.+?)\s+(?:[\w-]+\.)+[a-z]{2,}(?:\s|$)/i)
    if (domainBoundary) {
      return domainBoundary[1].trim()
    }

    return title
  }

  private normalizeQuestion(content: string): string {
    // Gemini often prepends screen-reader text like "You said" to user prompts.
    return content.replace(/^\s*you\s+said\s*/i, '').replace(/\s+/g, ' ').trim()
  }

  private normalizeText(content?: string | null): string {
    return (content || '').replace(/\s+/g, ' ').trim()
  }

  private getResponseContainers(): Element[] {
    const responseContainerSelector = this.resolveSelector('responseContainer')
    if (!responseContainerSelector) {
      console.warn('[GeminiParser] Missing config selector: responseContainer')
      return []
    }

    return Array.from(document.querySelectorAll(responseContainerSelector))
  }

  private getUserQuestions(): string[] {
    if (!this.selectors.userMessage) {
      return []
    }

    return Array.from(document.querySelectorAll(this.selectors.userMessage))
      .map((msg) => this.normalizeQuestion(this.normalizeText(msg.textContent)))
      .filter(Boolean)
  }

  private getQuestionForResponseContainer(container: Element): string | undefined {
    const responseContainers = this.getResponseContainers()
    if (responseContainers.length === 0) {
      return undefined
    }

    const responseIndex = responseContainers.findIndex((candidate) => candidate === container)
    const questions = this.getUserQuestions()

    if (responseIndex >= 0 && responseIndex < questions.length) {
      return questions[responseIndex]
    }

    return questions.length > 0 ? questions[questions.length - 1] : undefined
  }

  private findResponseContainerForContent(responseContent?: string): Element | undefined {
    const responseContainers = this.getResponseContainers()
    if (responseContainers.length === 0) {
      return undefined
    }

    const normalizedResponseContent = this.normalizeText(responseContent)
    if (!normalizedResponseContent) {
      return responseContainers[responseContainers.length - 1]
    }

    for (let i = responseContainers.length - 1; i >= 0; i--) {
      const container = responseContainers[i]
      const containerText = this.normalizeText(container.textContent)
      if (!containerText) {
        continue
      }

      if (containerText.includes(normalizedResponseContent)) {
        return container
      }
    }

    return responseContainers[responseContainers.length - 1]
  }

  /**
   * Public method for browser.mts to resolve and store the specific container element
   * at the time a response is enqueued, preventing stale content matching during promotion.
   */
  public resolveContainer(responseContent?: string): Element | undefined {
    return this.findResponseContainerForContent(responseContent)
  }

  public isSourceExtractionComplete(responseContentOrContainer?: string | Element): boolean {
    const responseContainer: Element | undefined = responseContentOrContainer instanceof Element
      ? responseContentOrContainer
      : this.findResponseContainerForContent(responseContentOrContainer)
    if (!responseContainer) {
      return false
    }

    const questionForTurn = this.getQuestionForResponseContainer(responseContainer)
    const responseContainerId = this.getOrCreateResponseContainerId(responseContainer)
    const currentResponseId = questionForTurn ? `${questionForTurn}:${responseContainerId}` : responseContainerId

    return !!currentResponseId && this.extractedResponseIds.has(currentResponseId)
  }

  public getSourceExtractionStatus(responseContentOrContainer?: string | Element): GeminiSourceExtractionClassification | undefined {
    const responseContainer: Element | undefined = responseContentOrContainer instanceof Element
      ? responseContentOrContainer
      : this.findResponseContainerForContent(responseContentOrContainer)
    if (!responseContainer) {
      return undefined
    }

    const questionForTurn = this.getQuestionForResponseContainer(responseContainer)
    const responseContainerId = this.getOrCreateResponseContainerId(responseContainer)
    const currentResponseId = questionForTurn ? `${questionForTurn}:${responseContainerId}` : responseContainerId
    return this.sourceExtractionStatusByResponseId.get(currentResponseId)
  }

  public abortSourceExtraction(responseContentOrContainer?: string | Element): void {
    const responseContainer: Element | undefined = responseContentOrContainer instanceof Element
      ? responseContentOrContainer
      : this.findResponseContainerForContent(responseContentOrContainer)
    if (!responseContainer) {
      return
    }

    const questionForTurn = this.getQuestionForResponseContainer(responseContainer)
    const responseContainerId = this.getOrCreateResponseContainerId(responseContainer)
    const currentResponseId = questionForTurn ? `${questionForTurn}:${responseContainerId}` : responseContainerId
    const panelOwnedByCurrentTurn =
      !!currentResponseId && this.panelOpenedByParserForResponseId === currentResponseId

    if (!panelOwnedByCurrentTurn) {
      return
    }

    const panelOpen =
      !!document.querySelector('context-sidebar:not([aria-hidden="true"])') ||
      !!document.querySelector('side-bar-sources:not([aria-hidden="true"])') ||
      this.isDialogOpen()
    if (panelOpen) {
      const closeIcon = document.querySelector('mat-icon[data-mat-icon-name="close"]')
      const closeIconButton = closeIcon?.closest('button') as HTMLElement | null

      const configuredCloseSelector = this.resolveSelector('sourceCloseButton')
      const fallbackCloseSelectors = [
        'side-bar-sources button[data-test-id="close-button"]',
        'context-sidebar button[data-test-id="close-button"]',
        'side-bar-sources button[aria-label="Close sidebar"]',
        'context-sidebar button[aria-label="Close sidebar"]',
        'context-sidebar button[aria-label*="close" i]',
      ]

      const closeSelectors = configuredCloseSelector
        ? [configuredCloseSelector, ...fallbackCloseSelectors]
        : fallbackCloseSelectors

      let closeButton: HTMLElement | null = closeIconButton
      for (const selector of closeSelectors) {
        if (closeButton) {
          break
        }
        closeButton = document.querySelector(selector) as HTMLElement | null
      }

      if (closeButton) {
        closeButton.click()
      } else {
        this.closeTransientMenuOrDialog()
      }
    }

    this.panelOpenedByParserForResponseId = undefined
    console.log('[GeminiParser] Aborted source extraction and cleared panel ownership for pending turn')
  }

  private getOrCreateResponseContainerId(container: Element): string {
    let existingId = this.responseContainerIds.get(container)
    if (existingId) {
      return existingId
    }

    this.responseContainerSequence += 1
    existingId = `turn-${this.responseContainerSequence}`
    this.responseContainerIds.set(container, existingId)
    return existingId
  }

  private getOrCreateQuestionTimestamp(content: string, index: number): number {
    const key = `${content}:${index}`
    const existing = this.questionTimestampsByContentIndex.get(key)
    if (existing !== undefined) {
      return existing
    }

    // Ensure timestamps are unique even when multiple questions are processed in the same millisecond.
    const now = Date.now()
    const timestamp = now > this.lastAssignedQuestionTimestamp ? now : this.lastAssignedQuestionTimestamp + 1
    this.lastAssignedQuestionTimestamp = timestamp
    this.questionTimestampsByContentIndex.set(key, timestamp)
    return timestamp
  }

  private isDialogOpen(): boolean {
    return !!document.querySelector('[role="dialog"]:not([aria-hidden="true"])')
  }

  private closeTransientMenuOrDialog(): void {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  }

  private isCitationSourceButton(button: Element): boolean {
    const aria = (button.getAttribute('aria-label') || '').toLowerCase()
    const dataTestId = (button.getAttribute('data-test-id') || '').toLowerCase()
    const className = (button.getAttribute('class') || '').toLowerCase()

    // Ignore generic controls like footer "Sources" toggle buttons FIRST, before positive checks
    if (aria === 'sources' || className.includes('legacy-sources-sidebar-button')) {
      return false
    }

    if (aria.includes('view source details')) {
      return true
    }

    if (dataTestId.includes('source') || dataTestId.includes('citation')) {
      return true
    }

    return false
  }

  private isMoreMenuButton(button: Element): boolean {
    const aria = this.normalizeText(button.getAttribute('aria-label')).toLowerCase()
    const dataTestId = this.normalizeText(button.getAttribute('data-test-id')).toLowerCase()

    return dataTestId === 'more-menu-button' || aria === 'show more options' || aria === 'more'
  }

  private isViewSourcesMenuItem(element: Element): boolean {
    const text = this.normalizeText(element.textContent).toLowerCase()
    const aria = this.normalizeText(element.getAttribute('aria-label')).toLowerCase()
    const dataTestId = this.normalizeText(element.getAttribute('data-test-id')).toLowerCase()

    if (dataTestId.includes('view-source') || dataTestId.includes('view-sources')) {
      return true
    }

    return text.includes('view sources') || text.includes('view source') || aria.includes('view sources')
  }

  private findViewSourcesMenuItem(): HTMLElement | null {
    const configuredMenuItemSelector = this.resolveSelector('sourceMenuItem')
    const fallbackSelectors = [
      '[role="menuitem"]',
      '[role="menu"] button',
      '[role="menu"] [aria-label]',
      'button[aria-label*="view source" i]',
    ]

    const selectors = configuredMenuItemSelector
      ? [configuredMenuItemSelector, ...fallbackSelectors]
      : fallbackSelectors

    for (const selector of selectors) {
      let candidates: Element[] = []
      try {
        candidates = Array.from(document.querySelectorAll(selector))
      } catch {
        continue
      }

      const matched = candidates.find((candidate) => this.isViewSourcesMenuItem(candidate))
      if (matched instanceof HTMLElement) {
        return matched
      }
    }

    return null
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

  /**
   * Resolve a selector using configured fallback behavior.
   */
  private resolveSelector<K extends keyof GeminiSelectors>(key: K): string | undefined {
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

  extractInteractions(): ParsedInteraction[] {
    if (this.selectorValidationError) {
      console.error('[GeminiParser] Cannot extract - selector validation failed:', this.selectorValidationError)
      return []
    }

    const interactions: ParsedInteraction[] = []

    // Find user messages using config selector
    if (this.selectors.userMessage) {
      const userMessages = document.querySelectorAll(this.selectors.userMessage)
      console.log(`[GeminiParser] Found ${userMessages.length} user message elements`)
      userMessages.forEach((msg, index) => {
        const rawContent = msg.textContent?.trim()
        const content = rawContent ? this.normalizeQuestion(rawContent) : undefined
        if (content) {
          interactions.push({
            type: 'question',
            content,
            // Keyed by (content, position) so remounted DOM nodes return the
            // same stable timestamp, while identical questions at different
            // conversation positions get distinct timestamps.
            question_timestamp: this.getOrCreateQuestionTimestamp(content, index),
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

  isResponseComplete(responseContent?: string): boolean {
    const responseContainer = this.findResponseContainerForContent(responseContent)
    if (!responseContainer) {
      return false
    }

    const completeFooterSelector = this.resolveSelector('completeFooter')
    const copyActionSelector = this.resolveSelector('copyAction')
    const busyIndicatorSelector = this.resolveSelector('busyIndicator')

    if (!completeFooterSelector || !copyActionSelector || !busyIndicatorSelector) {
      console.warn(
        '[GeminiParser] Missing config selectors required for completion check: completeFooter, copyAction, busyIndicator',
      )
      return false
    }

    const hasCompleteFooter = responseContainer.querySelector(completeFooterSelector) !== null
    const hasCopyAction = responseContainer.querySelector(copyActionSelector) !== null
    const isBusy = responseContainer.querySelector(busyIndicatorSelector) !== null

    if (hasCompleteFooter) {
      return true
    }

    return hasCopyAction && !isBusy
  }

  extractSources(responseContentOrContainer?: string | Element): ExtractedSourceGroup[] {
    const responseContainer: Element | undefined = responseContentOrContainer instanceof Element
      ? responseContentOrContainer
      : this.findResponseContainerForContent(responseContentOrContainer)
    if (!responseContainer) {
      console.warn('[GeminiParser] No response containers found')
      return []
    }

    const questionForTurn = this.getQuestionForResponseContainer(responseContainer)
    const responseContainerId = this.getOrCreateResponseContainerId(responseContainer)
    const currentResponseId = questionForTurn ? `${questionForTurn}:${responseContainerId}` : responseContainerId

    // Skip if we've already extracted sources for this response
    if (currentResponseId && this.extractedResponseIds.has(currentResponseId)) {
      if (!this.loggedCompletedSkipResponseIds.has(currentResponseId)) {
        this.loggedCompletedSkipResponseIds.add(currentResponseId)
        console.log('[GeminiParser] Skipping source extraction - already completed for this response')
      }
      return []
    }

    // Scope response selectors to this response container to avoid cross-turn bleed.
    console.log('[GeminiParser] Config selectors:', {
      sourceAnchors: this.resolveSelector('sourceAnchors'),
      sourceButtons: this.resolveSelector('sourceButtons'),
      sourceDetailAnchors: this.resolveSelector('sourceDetailAnchors'),
      sourceToggleButton: this.resolveSelector('sourceToggleButton'),
      sourceCloseButton: this.resolveSelector('sourceCloseButton'),
    })

    const sources: ExtractedSource[] = []
    const seen = new Set<string>()

    const normalizeSourceUrl = (rawUrl?: string | null): string | undefined => {
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

    const normalizeSourceLabel = (label?: string): string | undefined => {
      if (!label) return undefined

      const normalized = label.replace(/\s+/g, ' ').trim()
      if (!normalized) return undefined

      // Gemini source a11y labels are often:
      // "View source details for citation from <SOURCE>. Opens side panel."
      const citationMatch = normalized.match(/citation\s+from\s+(.+?)(?:\.\s*opens\s+side\s+panel\.?|$)/i)
      if (citationMatch && citationMatch[1]) {
        return citationMatch[1].trim()
      }

      return normalized
    }

    const isNoiseLabel = (label?: string): boolean => {
      if (!label) return true
      const normalized = label.trim().toLowerCase()
      if (!normalized) return true
      if (normalized === 'sources') return true
      if (/^\+\d+$/.test(label.trim())) return true
      if (normalized.startsWith('view source details')) return true
      return false
    }

    const addSource = (source_title?: string, source_url?: string): void => {
      const parsedTitle = normalizeSourceLabel(source_title)
      const cleanTitle = parsedTitle?.trim()
      const cleanUrl = source_url?.trim()

      if (isNoiseLabel(cleanTitle) && !cleanUrl) {
        return
      }

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

    const extractUrlFromElement = (element: Element): string | undefined => {
      const attrs = ['href', 'data-url', 'data-href', 'data-source-url', 'data-presentation-url']
      for (const attr of attrs) {
        const value = normalizeSourceUrl(element.getAttribute(attr))
        if (value) {
          return value
        }
      }
      return undefined
    }

    const queryWithinLatestTurn = (selector: string): Element[] => {
      return Array.from(responseContainer.querySelectorAll(selector))
    }

    // Prefer explicit source links when present (scoped to latest response turn).
    const sourceAnchorSelector = this.resolveSelector('sourceAnchors')
    let latestTurnSourceAnchors: Element[] = []
    if (sourceAnchorSelector) {
      latestTurnSourceAnchors = queryWithinLatestTurn(sourceAnchorSelector)
      latestTurnSourceAnchors.forEach((anchor) => {
        const url = normalizeSourceUrl(anchor.getAttribute('href'))
        if (!url) {
          return
        }

        const title =
          anchor.textContent?.replace(/\s+/g, ' ').trim() ||
          anchor.getAttribute('aria-label') ||
          undefined
        addSource(title, url)
      })
    } else {
      console.warn('[GeminiParser] Missing config selector: sourceAnchors')
    }

    // Source chips/buttons are scoped to the latest response turn and only indicate
    // that citations exist for this response. They do not carry the source payload.
    const sourceButtonSelector = this.resolveSelector('sourceButtons')
    const latestTurnSourceButtons = sourceButtonSelector ? queryWithinLatestTurn(sourceButtonSelector) : []
    const latestTurnCitationButtons = latestTurnSourceButtons.filter((button) => this.isCitationSourceButton(button))

    // Some turns require opening the footer Sources toggle to expose source details.
    // Inline citation affordances (icon-only or +N variants) tell us citations exist,
    // but the actual source metadata is revealed only after the sources panel is opened.
    const sourceToggleSelector = this.resolveSelector('sourceToggleButton')
    const hasFooterSourceToggleInLatestTurn = sourceToggleSelector
      ? queryWithinLatestTurn(sourceToggleSelector).length > 0
      : false

    const sourceMenuButtonSelector = this.resolveSelector('sourceMenuButton')
    const latestTurnSourceMenuButtons = sourceMenuButtonSelector
      ? queryWithinLatestTurn(sourceMenuButtonSelector).filter((button) => this.isMoreMenuButton(button))
      : []

    const maybeOpenSourcesPanel = (): { opened: boolean; attempted: boolean; noSources: boolean } => {
      const panelOwnedByCurrentTurn =
        !!currentResponseId && this.panelOpenedByParserForResponseId === currentResponseId

      const clickTrigger = (toggle: HTMLElement, description: string): { opened: boolean; attempted: boolean; noSources: boolean } => {
        const className = toggle.getAttribute('class') || ''
        const alreadySelected = /\bselected\b/i.test(className)
        const ariaExpanded = (toggle.getAttribute('aria-expanded') || '').toLowerCase() === 'true'

        if (alreadySelected || ariaExpanded) {
          if (panelOwnedByCurrentTurn) {
            console.log(`[GeminiParser] ${description} already open for this response, skipping click`)
            return { opened: false, attempted: true, noSources: false }
          }

          toggle.click()
          this.panelOpenedByParserForResponseId = undefined
          console.log(`[GeminiParser] ${description} was open for another turn; closed. Will reopen on next extraction pass.`)
          return { opened: false, attempted: true, noSources: false }
        }

        toggle.click()
        console.log(`[GeminiParser] Clicked ${description} to reveal source URLs`)
        return { opened: true, attempted: true, noSources: false }
      }

      // More menu -> "View sources" tried FIRST. Confirmed live (2026-07-29):
      // the inline citation chip (e.g. "View source details for citations
      // from The Guardian...") still exists and matches isCitationSourceButton,
      // but clicking it does not populate any configured sourceDetailAnchors
      // selector -- across 8 retries with a real logged-in session, the
      // side panel never appeared. The More menu's "View sources" item is
      // the affordance that actually works in the current UI. The inline
      // chip and footer toggle are kept as fallbacks in case some other
      // response shape still relies on them.
      const menuButton = latestTurnSourceMenuButtons.find((button): button is HTMLElement => button instanceof HTMLElement)
      if (menuButton) {
        menuButton.click()
        console.log('[GeminiParser] Clicked More menu button while probing for View sources')

        const viewSourcesItem = this.findViewSourcesMenuItem()
        if (viewSourcesItem) {
          viewSourcesItem.click()
          console.log('[GeminiParser] Clicked View sources from More menu')
          return { opened: true, attempted: true, noSources: false }
        }

        this.closeTransientMenuOrDialog()
        console.log('[GeminiParser] More menu did not expose View sources for this turn; falling back to inline citation/toggle')
      }

      const inlineCitationTrigger = latestTurnCitationButtons.find((button): button is HTMLElement => button instanceof HTMLElement)
      if (inlineCitationTrigger) {
        return clickTrigger(inlineCitationTrigger, 'inline citation button')
      }

      const sourceToggle = sourceToggleSelector
        ? queryWithinLatestTurn(sourceToggleSelector).find((button): button is HTMLElement => button instanceof HTMLElement)
        : undefined
      if (sourceToggle) {
        return clickTrigger(sourceToggle, 'sources toggle')
      }

      // More menu was tried above; if it existed but did not expose View
      // sources, and no other affordance is available, report noSources.
      if (menuButton) {
        return { opened: false, attempted: true, noSources: true }
      }

      return { opened: false, attempted: false, noSources: false }
    }

    // If latest turn has no source affordance at all, do not read side panel anchors (which can be stale).
    const hasSourceAffordanceInLatestTurn =
      latestTurnSourceAnchors.length > 0 ||
      latestTurnCitationButtons.length > 0 ||
      hasFooterSourceToggleInLatestTurn ||
      latestTurnSourceMenuButtons.length > 0
    if (!hasSourceAffordanceInLatestTurn) {
      if (currentResponseId) { this.extractedResponseIds.add(currentResponseId) }
      console.log('[GeminiParser] Latest response has no source affordance; returning empty sources for this turn')
      return []
    }

    // Additional source detail links are often rendered in side panels.
    const sourceDetailAnchorSelector = this.resolveSelector('sourceDetailAnchors')
    let sourceDetailAnchors: Element[] = []
    const panelOwnedByCurrentTurn =
      !!currentResponseId && this.panelOpenedByParserForResponseId === currentResponseId
    
    if (sourceDetailAnchorSelector) {
      // Never trust a pre-existing global side panel unless it is known to belong
      // to this response turn, otherwise stale sources can bleed across turns.
      sourceDetailAnchors = panelOwnedByCurrentTurn ? Array.from(document.querySelectorAll(sourceDetailAnchorSelector)) : []
      console.log(
        `[GeminiParser] Found ${sourceDetailAnchors.length} source detail anchors with selector: ${sourceDetailAnchorSelector}`,
      )
    } else {
      console.warn('[GeminiParser] Missing config selector: sourceDetailAnchors')
    }

    let openedByParser = false
    let revealAttempted = false
    let menuReportedNoSources = false
    if (sourceDetailAnchors.length === 0) {
      // Attempt to open the sources panel for this turn when detail anchors are not yet visible.
      console.log('[GeminiParser] No detail anchors found, checking for source button')
      const revealResult = maybeOpenSourcesPanel()
      openedByParser = revealResult.opened
      revealAttempted = revealResult.attempted
      menuReportedNoSources = revealResult.noSources
      
      if (openedByParser && currentResponseId) {
        this.panelOpenedByParserForResponseId = currentResponseId
        // Panel now open for this turn - anchors will be visible in DOM after Gemini re-renders
        const sourceDetailAnchors_Retry = sourceDetailAnchorSelector ? Array.from(document.querySelectorAll(sourceDetailAnchorSelector)) : []
        if (sourceDetailAnchors_Retry.length > 0) {
          sourceDetailAnchors = sourceDetailAnchors_Retry
          console.log(`[GeminiParser] Extracted ${sourceDetailAnchors.length} detail anchors after panel open`)
        } else {
          console.log('[GeminiParser] Panel opened but no anchors found yet - will retry on next mutation')
        }
      }
    }
    sourceDetailAnchors.forEach((anchor) => {
      const url = extractUrlFromElement(anchor)
      if (!url) {
        return
      }

      const sourceCard = anchor.closest('inline-source-card') as HTMLElement | null
      const cardTitle = sourceCard?.querySelector('div.title.gds-title-m')?.textContent?.replace(/\s+/g, ' ').trim()
      const cardPath = sourceCard?.querySelector('div.source-path.gds-title-s')?.textContent?.replace(/\s+/g, ' ').trim()

      const title =
        cardTitle ||
        cardPath ||
        anchor.textContent?.replace(/\s+/g, ' ').trim() ||
        anchor.getAttribute('aria-label') ||
        undefined
      addSource(title, url)
    })

    // Citation buttons are affordance-only and are intentionally not converted into
    // sources. Actual source metadata must come from explicit inline anchors or the
    // sources panel detail anchors revealed by the toggle.
    if (!sourceButtonSelector) {
      console.warn('[GeminiParser] Missing config selector: sourceButtons')
    }

    console.log(`[GeminiParser] Extracted ${sources.length} raw sources before dedup`)

    // ── Post-processing ──────────────────────────────────────────────────────
    // Step 1: strip domain + snippet text from titles ("SiteName domain.com excerpt" → "SiteName")
    const stripped = sources.map((s) => ({
      ...s,
      source_title: this.stripSnippetFromTitle(s.source_title, s.source_url),
    }))

    // Step 2: dedup URL-backed entries by base URL (strip #:~:text= / hash fragments)
    const getBaseUrl = (url: string): string => {
      try {
        const p = new URL(url)
        return p.origin + p.pathname
      } catch {
        return url.split('#')[0]
      }
    }

    const seenBaseUrls = new Set<string>()
    const urlBacked: ExtractedSource[] = []
    const titleOnly: ExtractedSource[] = []

    for (const s of stripped) {
      if (s.source_url) {
        const base = getBaseUrl(s.source_url)
        if (!seenBaseUrls.has(base)) {
          seenBaseUrls.add(base)
          urlBacked.push(s)
        } else {
          console.log(`[GeminiParser] Dedup: dropping duplicate base URL ${base}`)
        }
      } else {
        titleOnly.push(s)
      }
    }

    // Step 3: drop title-only orphans covered by a URL-backed entry
    // Build lookup of site names / domains from URL-backed entries
    const urlBackedNames = new Set<string>()
    for (const s of urlBacked) {
      urlBackedNames.add(s.source_title.toLowerCase())
      if (s.source_url) {
        try {
          urlBackedNames.add(new URL(s.source_url).hostname.replace(/^www\./, '').toLowerCase())
        } catch { /* ignore */ }
      }
    }

    const keptOrphans = titleOnly.filter((s) => {
      const t = s.source_title.toLowerCase()
      const covered = Array.from(urlBackedNames).some((name) => name.includes(t) || t.includes(name))
      if (covered) {
        console.log(`[GeminiParser] Dedup: dropping title-only orphan "${s.source_title}" (covered by URL-backed entry)`)
      }
      return !covered
    })

    const dedupedSources = [...urlBacked, ...keptOrphans]
    console.log(`[GeminiParser] After dedup: ${dedupedSources.length} sources`)

    // ── Step 4: group into domain groups ────────────────────────────────────────
    // Attempt to enrich each source with domain metadata from inline-source-card elements.
    const cardEnrichment = new Map<string, { domain_title: string; domain_name: string }>()
    const allCards = Array.from(document.querySelectorAll('inline-source-card'))
    for (const card of allCards) {
      const anchor = (card.closest('a[href]') || card.querySelector('a[href]')) as HTMLAnchorElement | null
      if (!anchor) continue
      const rawUrl = normalizeSourceUrl(anchor.getAttribute('href'))
      if (!rawUrl) continue
      const baseUrl = getBaseUrl(rawUrl)
      if (!cardEnrichment.has(baseUrl)) {
        const domainTitle = (card.querySelector('div.source-path.gds-title-s') as HTMLElement)?.innerText?.trim() || ''
        const domainName = (card.querySelector('div.info.gds-body-s') as HTMLElement)?.innerText?.trim() || ''
        cardEnrichment.set(baseUrl, { domain_title: domainTitle, domain_name: domainName })
      }
    }

    const sourceGroupMap = new Map<string, ExtractedSourceGroup>()
    for (const s of dedupedSources) {
      const baseUrl = s.source_url ? getBaseUrl(s.source_url) : undefined
      const enrichment = baseUrl ? cardEnrichment.get(baseUrl) : undefined
      let domainTitle: string
      let domainName: string
      if (enrichment) {
        domainTitle = enrichment.domain_title
        domainName = enrichment.domain_name
      } else if (s.source_url) {
        try { domainName = new URL(s.source_url).hostname.replace(/^www\./, '') } catch { domainName = '' }
        domainTitle = s.source_title
      } else {
        domainTitle = s.source_title
        domainName = ''
      }
      const groupKey = domainName || domainTitle || s.source_title
      if (!sourceGroupMap.has(groupKey)) {
        sourceGroupMap.set(groupKey, { domain_title: domainTitle, domain_name: domainName, sources: [] })
      }
      sourceGroupMap.get(groupKey)!.sources.push({ source_title: s.source_title, source_url: s.source_url })
    }
    const sourceGroups = Array.from(sourceGroupMap.values())
    console.log(`[GeminiParser] Grouped into ${sourceGroups.length} domain groups`)

    const hasUrlSourceFinal = dedupedSources.some((source) => !!source.source_url)

    const closeSourcesPanelIfOpen = (): void => {
      const panelOpen =
        !!document.querySelector('context-sidebar:not([aria-hidden="true"])') ||
        !!document.querySelector('side-bar-sources:not([aria-hidden="true"])') ||
        this.isDialogOpen()
      if (!panelOpen) {
        return
      }

      // Confirmed live (2026-07-29): the sources panel has a dedicated close
      // button -- a mat-icon (fonticon="close", data-mat-icon-name="close")
      // whose enclosing <button> is the actual clickable close control. This
      // is the real close affordance and is tried first. The earlier
      // "reopen More menu -> View sources" toggle-close approach was tried
      // and confirmed NOT to work in automated testing (the reopened menu
      // did not expose "View sources" as a findable item, and the panel
      // remained open across repeated live runs), so it is kept only as a
      // fallback below in case this selector doesn't match some UI variant.
      const closeIcon = document.querySelector('mat-icon[data-mat-icon-name="close"]')
      const closeIconButton = closeIcon?.closest('button') as HTMLElement | null
      if (closeIconButton) {
        closeIconButton.click()
        console.log('[GeminiParser] Closed sources panel via mat-icon close button')
        return
      }

      const configuredCloseSelector = this.resolveSelector('sourceCloseButton')
      const fallbackCloseSelectors = [
        'side-bar-sources button[data-test-id="close-button"]',
        'context-sidebar button[data-test-id="close-button"]',
        'side-bar-sources button[aria-label="Close sidebar"]',
        'context-sidebar button[aria-label="Close sidebar"]',
        'context-sidebar button[aria-label*="close" i]',
      ]

      const closeSelectors = configuredCloseSelector
        ? [configuredCloseSelector, ...fallbackCloseSelectors]
        : fallbackCloseSelectors

      let closeButton: HTMLElement | null = null
      for (const selector of closeSelectors) {
        closeButton = document.querySelector(selector) as HTMLElement | null
        if (closeButton) {
          break
        }
      }

      if (closeButton) {
        closeButton.click()
        console.log('[GeminiParser] Closed sources panel')
        return
      }

      const menuButtonForClose = latestTurnSourceMenuButtons.find(
        (button): button is HTMLElement => button instanceof HTMLElement,
      )
      if (menuButtonForClose) {
        menuButtonForClose.click()
        const viewSourcesItemForClose = this.findViewSourcesMenuItem()
        if (viewSourcesItemForClose) {
          viewSourcesItemForClose.click()
          console.log('[GeminiParser] Closed sources panel by reopening More menu -> View sources')
          return
        }
        this.closeTransientMenuOrDialog()
      }

      // Last resort for UI variants where none of the above apply.
      this.closeTransientMenuOrDialog()
      console.log('[GeminiParser] Attempted to close sources panel via Escape fallback')
    }

    const panelOwnedAtClose =
      !!currentResponseId && this.panelOpenedByParserForResponseId === currentResponseId

    const clearPanelOwnership = (): void => {
      if (!panelOwnedAtClose) {
        return
      }
      this.panelOpenedByParserForResponseId = undefined
      console.log('[GeminiParser] Cleared panel ownership - next turn will open fresh panel')
    }

    const finalizeEmptySources = (reason: string): ExtractedSourceGroup[] => {
      // Finalized turn: if parser owns the panel for this turn, close it before exiting.
      if (panelOwnedAtClose) {
        closeSourcesPanelIfOpen()
      }
      clearPanelOwnership()
      if (currentResponseId) { this.extractedResponseIds.add(currentResponseId) }
      if (currentResponseId) { this.sourceExtractionStatusByResponseId.set(currentResponseId, 'none') }
      if (currentResponseId) { this.loggedCompletedSkipResponseIds.delete(currentResponseId) }
      console.log(reason)
      return []
    }

    // Only mark response as complete once we have at least one URL-backed source.
    if (hasUrlSourceFinal) {
      // URL-backed extraction complete for this turn: close owned panel and clear ownership.
      if (panelOwnedAtClose) {
        closeSourcesPanelIfOpen()
      }
      clearPanelOwnership()
      if (currentResponseId) { this.extractedResponseIds.add(currentResponseId) }
      if (currentResponseId) { this.sourceExtractionStatusByResponseId.set(currentResponseId, 'success') }
      if (currentResponseId) { this.loggedCompletedSkipResponseIds.delete(currentResponseId) }
      console.log(`[GeminiParser] Response extraction complete (found ${dedupedSources.length} sources)`)
    } else {
      const citationCandidateCount = latestTurnCitationButtons.length

      // If this call opened the panel but anchors are not in DOM yet, wait for next mutation.
      // This avoids finalizing empty before Gemini hydrates side-panel links.
      if (openedByParser && sourceDetailAnchors.length === 0) {
        console.log('[GeminiParser] Panel opened for current turn; waiting for panel links on next mutation')
        return []
      }

      // Some Gemini responses legitimately have no sources. Finalize those turns with empty sources.
      if (
        citationCandidateCount === 0 &&
        sourceDetailAnchors.length === 0 &&
        latestTurnSourceAnchors.length === 0 &&
        !hasFooterSourceToggleInLatestTurn &&
        !revealAttempted
      ) {
        return finalizeEmptySources('[GeminiParser] No source citations detected for this turn - finalizing with empty sources')
      }

      if (menuReportedNoSources && sourceDetailAnchors.length === 0) {
        return finalizeEmptySources('[GeminiParser] More menu exposed no View sources action for this turn - finalizing with empty sources')
      }

      // If citation affordances or a sources toggle exist for this turn, do not finalize
      // with an empty payload. Keep waiting until real source detail data is extracted.
      if (
        (citationCandidateCount > 0 || hasFooterSourceToggleInLatestTurn || latestTurnSourceMenuButtons.length > 0) &&
        sourceDetailAnchors.length === 0
      ) {
        // Exception: if the panel was already opened by a previous call (panelOwnedByCurrentTurn)
        // but detail anchors still haven't appeared on retry (revealAttempted=true, panel already
        // selected so openedByParser=false), collect chip metadata as partial sources to avoid
        // holding the interaction indefinitely (e.g. Gemini logged-in with chip-only state).
        if (panelOwnedByCurrentTurn && revealAttempted && !openedByParser && citationCandidateCount > 0) {
          const chipSources = (latestTurnCitationButtons as HTMLElement[]).reduce<ExtractedSourceGroup[]>((groups, button) => {
            const ariaLabel = (button.getAttribute('aria-label') || '').trim()
            const nameMatch = ariaLabel.match(/citation from\s+(.+?)\s*\.\s+Press Enter/i)
            const chipTitle = nameMatch
              ? nameMatch[1].trim()
              : this.stripSnippetFromTitle(button.textContent?.replace(/\s+/g, ' ').trim() || '')
            if (chipTitle) {
              groups.push({ domain_title: chipTitle, domain_name: '', sources: [{ source_title: chipTitle, source_url: undefined }] })
            }
            return groups
          }, [])
          if (chipSources.length > 0) {
            if (panelOwnedAtClose) { closeSourcesPanelIfOpen() }
            clearPanelOwnership()
            if (currentResponseId) { this.extractedResponseIds.add(currentResponseId) }
            if (currentResponseId) { this.sourceExtractionStatusByResponseId.set(currentResponseId, 'none') }
            if (currentResponseId) { this.loggedCompletedSkipResponseIds.delete(currentResponseId) }
            console.log(`[GeminiParser] Panel open but anchors empty after retry; finalizing with ${chipSources.length} chip-based partial sources`)
            return chipSources
          }
        }
        console.log('[GeminiParser] Citation affordance present but no source detail links captured yet - waiting for next mutation')
        return []
      }

      console.log('[GeminiParser] No URL-backed sources found yet - will retry on next mutation')
      return []
    }

    return sourceGroups
  }
}
