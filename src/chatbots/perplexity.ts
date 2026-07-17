/**
 * Perplexity.ai Parser
 * Extracts Q&A pairs from Perplexity chatbot interface
 */

export interface ParsedInteraction {
  type: 'question' | 'response'
  content: string
  question_timestamp?: number
}

export interface PerplexitySelectors {
  userQuestion?: string
  assistantResponse?: string
  responseContainer?: string
  copyAction?: string
  busyIndicator?: string
  sourceToggleButton?: string
  sourceDetailAnchors?: string
  sourceCloseButton?: string
  messageContainer?: string
  citationElements?: string
  citationTitle?: string
}

export type PerplexitySelectorFallbacks = Partial<Record<keyof PerplexitySelectors, string[]>>

export type PerplexityFallbackMode = 'append' | 'replace' | 'none'

export interface ExtractedSource {
  source_title: string
  source_url?: string
}

export interface ExtractedSourceGroup {
  domain_title: string
  domain_name: string
  sources: ExtractedSource[]
}

export type SourceExtractionClassification =
  | 'success'
  | 'none'
  | 'terminal_empty'
  | 'data_capture_error'
  | 'panel_opening_failure'

export interface SourceExtractionResult {
  sources: ExtractedSourceGroup[]
  source_extraction: SourceExtractionClassification
  close_panel?: boolean
}

export interface PerplexityConfig {
  enabled?: boolean
  selectors?: PerplexitySelectors
  fallback_mode?: PerplexityFallbackMode
  selector_fallbacks?: PerplexitySelectorFallbacks
}

export interface SelectorValidation {
  valid: boolean
  questionsFound: number
  responsesFound: number
}

export class PerplexityParser {
  name = 'perplexity'
  selectors: PerplexitySelectors
  private fallbackMode: PerplexityFallbackMode
  private selectorFallbacks: PerplexitySelectorFallbacks
  private selectorValidationError: string | null = null
  private extractedResponseIds = new Set<string>()
  private panelOpenedByParserForResponseId: string | undefined = undefined
  private responseContainerIds = new Map<Element, string>()
  private responseContainerSequence = 0
  private questionTimestampsByContentIndex = new Map<string, number>()
  private lastAssignedQuestionTimestamp = 0

  constructor(config?: PerplexityConfig) {
    // Use config selectors or fail
    this.selectors = config?.selectors || {}
    this.fallbackMode = config?.fallback_mode || 'append'
    this.selectorFallbacks = config?.selector_fallbacks || {}
    
    // STRICT MODE: Validate required selectors
    const required: (keyof PerplexitySelectors)[] = [
      'userQuestion',
      'assistantResponse',
      'responseContainer',
      'copyAction',
      'sourceToggleButton',
      'sourceDetailAnchors'
    ]
    
    const missing = required.filter(key => !this.selectors[key])
    if (missing.length > 0) {
      this.selectorValidationError = `Missing required selectors: ${missing.join(', ')}`
      console.error(`[PerplexityParser] ${this.selectorValidationError}`)
      this.reportConfigValidationFailure(this.selectorValidationError)
    }
    
    console.log('[PerplexityParser] Initialized with selectors:', this.selectors)
  }

  private normalizeText(content?: string | null): string {
    return (content || '').replace(/\s+/g, ' ').trim()
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

  private resolveSelector<K extends keyof PerplexitySelectors>(key: K): string | undefined {
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

    const candidates = [primary, ...fallbacks].filter(Boolean) as string[]
    for (const selector of candidates) {
      try {
        if (document.querySelector(selector)) {
          return selector
        }
      } catch {
        // Ignore invalid selectors and try next.
      }
    }

    return primary || fallbacks[0]
  }

  private getResponseContainers(): Element[] {
    const responseContainerSelector = this.resolveSelector('responseContainer')
    if (!responseContainerSelector) {
      return []
    }

    return Array.from(document.querySelectorAll(responseContainerSelector))
  }

  private getUserQuestions(): string[] {
    const questionSelector = this.resolveSelector('userQuestion')
    if (!questionSelector) {
      return []
    }

    return Array.from(document.querySelectorAll(questionSelector))
      .map((msg) => this.normalizeText(msg.textContent))
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

    const now = Date.now()
    const timestamp = now > this.lastAssignedQuestionTimestamp ? now : this.lastAssignedQuestionTimestamp + 1
    this.lastAssignedQuestionTimestamp = timestamp
    this.questionTimestampsByContentIndex.set(key, timestamp)
    return timestamp
  }

  private getCurrentResponseId(responseContainer: Element): string {
    const questionForTurn = this.getQuestionForResponseContainer(responseContainer)
    const responseContainerId = this.getOrCreateResponseContainerId(responseContainer)
    return questionForTurn ? `${questionForTurn}:${responseContainerId}` : responseContainerId
  }

  private waitForPanelVisible(questionForTurn?: string, timeoutMs: number = 1200): Promise<Element | null> {
    return new Promise((resolve) => {
      let settled = false

      const cleanup = () => {
        observer.disconnect()
        clearTimeout(timeoutHandle)
      }

      const finish = (panel: Element | null) => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        resolve(panel)
      }

      const evaluatePanel = () => {
        const panel = this.findOpenSourcesPanel(questionForTurn)
        if (panel && panel.isConnected && panel.getClientRects().length > 0) {
          finish(panel)
        }
      }

      const observer = new MutationObserver(() => {
        evaluatePanel()
      })

      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
      })

      const timeoutHandle = setTimeout(() => {
        finish(null)
      }, timeoutMs)

      evaluatePanel()
    })
  }

  private waitForSourceDetails(
    questionForTurn: string | undefined,
    sourceDetailSelector: string,
    timeoutMs: number = 1200,
  ): Promise<{ panel: Element | null; detailCount: number }> {
    return new Promise((resolve) => {
      let settled = false

      const cleanup = () => {
        observer.disconnect()
        clearTimeout(timeoutHandle)
      }

      const getSnapshot = (): { panel: Element | null; detailCount: number } => {
        const panel = this.findOpenSourcesPanel(questionForTurn)
        if (!panel || !panel.isConnected || panel.getClientRects().length === 0) {
          return { panel: null, detailCount: 0 }
        }

        const detailCount = panel.querySelectorAll(sourceDetailSelector).length
        return { panel, detailCount }
      }

      const finish = (snapshot: { panel: Element | null; detailCount: number }) => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        resolve(snapshot)
      }

      const evaluateDetails = () => {
        const snapshot = getSnapshot()
        if (snapshot.panel && snapshot.detailCount > 0) {
          finish(snapshot)
        }
      }

      const observer = new MutationObserver(() => {
        evaluateDetails()
      })

      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
      })

      const timeoutHandle = setTimeout(() => {
        finish(getSnapshot())
      }, timeoutMs)

      evaluateDetails()
    })
  }

  private finalizeExtraction(
    responseContainer: Element,
    currentResponseId: string,
    sourceExtraction: SourceExtractionClassification,
  ): void {
    // Keep data_capture_error retryable for future response updates in the same turn.
    if (sourceExtraction === 'data_capture_error') {
      return
    }

    this.extractedResponseIds.add(currentResponseId)
  }

  private isSourcesToggleButton(button: Element): boolean {
    const aria = (button.getAttribute('aria-label') || '').toLowerCase()
    if (aria.includes('source')) {
      return true
    }

    const text = this.normalizeText(button.textContent).toLowerCase()
    return /\b\d+\s+sources\b/.test(text) || /\bsources\b/.test(text)
  }

  private getSourceToggleInContainer(container: Element): HTMLElement | null {
    const toggleSelector = this.resolveSelector('sourceToggleButton')
    if (!toggleSelector) {
      return null
    }

    const candidates = Array.from(container.querySelectorAll(toggleSelector))
    const matched = candidates.find((candidate) => this.isSourcesToggleButton(candidate))
    // During early render the toggle text can be empty; keep a structural fallback
    // so extraction can proceed on a valid configured selector match.
    return ((matched || candidates[0]) as HTMLElement | undefined) || null
  }

  private getVisibleSourceCountSignal(sourceToggle: HTMLElement | null): number {
    if (!sourceToggle) {
      return 0
    }

    const text = this.normalizeText(sourceToggle.textContent).toLowerCase()
    const match = text.match(/(\d+)\s+sources?\b/)
    if (!match) {
      return 0
    }

    const parsed = Number(match[1])
    return Number.isFinite(parsed) ? parsed : 0
  }

  private getActiveCitationsPanels(): Element[] {
    const candidates = Array.from(document.querySelectorAll('div[role="tabpanel"][data-state="active"]'))
    return candidates.filter((panel) => {
      const id = (panel.getAttribute('id') || '').toLowerCase()
      const labelledBy = (panel.getAttribute('aria-labelledby') || '').toLowerCase()
      const text = this.normalizeText(panel.textContent).toLowerCase()

      return id.includes('citation') || labelledBy.includes('citation') || text.includes('sources for')
    })
  }

  private getPanelQuestion(panel: Element): string | undefined {
    const scopedCandidates = Array.from(panel.querySelectorAll('div, span, p'))
    for (const candidate of scopedCandidates) {
      const text = this.normalizeText(candidate.textContent)
      if (!text) {
        continue
      }

      const lower = text.toLowerCase()
      if (!lower.startsWith('sources for ')) {
        continue
      }

      return this.normalizeText(text.replace(/^sources\s+for\s+/i, '')) || undefined
    }

    const panelText = this.normalizeText(panel.textContent)
    const fallbackMatch = panelText.match(/sources\s+for\s+([^\n]+)/i)
    if (!fallbackMatch || !fallbackMatch[1]) {
      return undefined
    }

    return this.normalizeText(fallbackMatch[1]) || undefined
  }

  private panelMatchesQuestion(panel: Element, question?: string): boolean {
    if (!question) {
      return true
    }

    const normalizedQuestion = this.normalizeText(question).toLowerCase()
    if (!normalizedQuestion) {
      return true
    }

    const panelQuestion = this.getPanelQuestion(panel)
    if (!panelQuestion) {
      return false
    }

    const normalizedPanelQuestion = this.normalizeText(panelQuestion).toLowerCase()
    return (
      normalizedPanelQuestion.includes(normalizedQuestion) ||
      normalizedQuestion.includes(normalizedPanelQuestion)
    )
  }

  private findOpenSourcesPanel(question?: string): Element | null {
    const sourceDetailAnchorSelector = this.resolveSelector('sourceDetailAnchors')
    const panelCandidates = this.getActiveCitationsPanels()

    if (panelCandidates.length === 0) {
      // Do not infer "panel open" from global citation anchors. Inline citations
      // inside the response body can exist while the sources panel is still closed.
      return null
    }

    if (question) {
      const matchForQuestion = panelCandidates.find((panel) => this.panelMatchesQuestion(panel, question))
      if (matchForQuestion) {
        return matchForQuestion
      }
    }

    if (sourceDetailAnchorSelector) {
      const withAnchors = panelCandidates.find((panel) => panel.querySelector(sourceDetailAnchorSelector))
      if (withAnchors) {
        return withAnchors
      }
    }

    return panelCandidates[0]
  }

  private closeSourcesPanel(responseContainer?: Element): void {
    const questionForTurn = responseContainer ? this.getQuestionForResponseContainer(responseContainer) : undefined
    const activePanelForTurn = this.findOpenSourcesPanel(questionForTurn)
    const activePanelToClose = activePanelForTurn || this.findOpenSourcesPanel()

    // When closing the current-turn tabpanel, prefer clicking the Sources toggle
    // because the UI uses the same control for open/close.
    if (responseContainer && activePanelForTurn) {
      const toggle = this.getSourceToggleInContainer(responseContainer)
      if (toggle) {
        toggle.click()
        return
      }
    }

    const configuredCloseSelector = this.resolveSelector('sourceCloseButton')
    if (configuredCloseSelector && activePanelToClose) {
      const closeButton = activePanelToClose.querySelector(configuredCloseSelector) as HTMLElement | null
      if (closeButton) {
        closeButton.click()
        return
      }
    }

    const closeButtonFallbackSelectors = [
      'button[aria-label="Close"]',
      'button[aria-label="Dismiss"]',
      'button[aria-label*="close" i]',
      'button[aria-label*="dismiss" i]',
    ]

    if (activePanelToClose) {
      for (const selector of closeButtonFallbackSelectors) {
        const fallbackClose = activePanelToClose.querySelector(selector) as HTMLElement | null
        if (fallbackClose) {
          fallbackClose.click()
          return
        }
      }
    }

    // Fallback: click the toggle to collapse the open panel.
    // This is safe here because closeSourcesPanel is only called from abortSourceExtraction
    // after confirming panelOpenedByParserForResponseId === currentResponseId, meaning we
    // opened the panel and it is currently open on our behalf.
    if (responseContainer) {
      const toggle = this.getSourceToggleInContainer(responseContainer)
      if (toggle) {
        toggle.click()
        return
      }
    }

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  }

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

    const currentResponseId = this.getCurrentResponseId(responseContainer)
    return this.extractedResponseIds.has(currentResponseId)
  }

  public abortSourceExtraction(responseContentOrContainer?: string | Element): void {
    const responseContainer: Element | undefined = responseContentOrContainer instanceof Element
      ? responseContentOrContainer
      : this.findResponseContainerForContent(responseContentOrContainer)
    if (!responseContainer) {
      return
    }

    const currentResponseId = this.getCurrentResponseId(responseContainer)
    if (this.panelOpenedByParserForResponseId === currentResponseId) {
      this.closeSourcesPanel(responseContainer)
      this.panelOpenedByParserForResponseId = undefined
    }
  }

  private reportConfigValidationFailure(error: string): void {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(chrome.runtime.sendMessage as any)({
        messageType: 'llmConfigValidationFailure',
        payload: {
          source: 'perplexity',
          error,
          timestamp: Date.now(),
          url: window.location.href,
          selectors: this.selectors
        }
      })
    } catch (e) {
      console.error('[PerplexityParser] Failed to report config failure:', e)
    }
  }

  /**
   * Validate that current selectors can find elements on the page
   * Useful for detecting if DOM structure has changed and selectors need updating
   */
  validateSelectors(): SelectorValidation {
    const questionSelector = this.resolveSelector('userQuestion') || ''
    const responseSelector = this.resolveSelector('assistantResponse') || ''

    const questionElements = questionSelector ? document.querySelectorAll(questionSelector) : []
    const responseElements = responseSelector ? document.querySelectorAll(responseSelector) : []

    const validation: SelectorValidation = {
      valid: questionElements.length > 0 && responseElements.length > 0,
      questionsFound: questionElements.length,
      responsesFound: responseElements.length,
    }

    console.log('[PerplexityParser] Selector validation:', validation)
    return validation
  }

  extractInteractions(): ParsedInteraction[] {
    if (this.selectorValidationError) {
      console.error('[PerplexityParser] Cannot extract - selector validation failed:', this.selectorValidationError)
      return []
    }

    const interactions: ParsedInteraction[] = []

    // Find all user questions using config selector
    const questionSelector = this.resolveSelector('userQuestion')
    if (questionSelector) {
      const userMessages = document.querySelectorAll(questionSelector)
      console.log(`[PerplexityParser] Found ${userMessages.length} user question elements`)
      userMessages.forEach((msg, index) => {
        const content = this.normalizeText(msg.textContent)
        if (content) {
          interactions.push({
            type: 'question',
            content,
            question_timestamp: this.getOrCreateQuestionTimestamp(content, index),
          })
        }
      })
    }

    // Find all assistant responses using config selector.
    // Perplexity frequently leaves behind empty markdown-content placeholders
    // while rendering actual content under data-renderer="lm" nodes.
    const assistantSelector = this.resolveSelector('assistantResponse')
    const seenResponses = new Set<string>()

    const appendResponse = (raw: string) => {
      const content = this.normalizeText(raw)
      if (!content || seenResponses.has(content)) {
        return
      }

      seenResponses.add(content)
      interactions.push({
        type: 'response',
        content,
      })
    }

    if (assistantSelector) {
      const botResponses = document.querySelectorAll(assistantSelector)
      console.log(`[PerplexityParser] Found ${botResponses.length} assistant response elements`)
      botResponses.forEach((msg) => {
        appendResponse(msg.textContent ?? '')
      })
    }

    if (seenResponses.size === 0) {
      const fallbackResponseSelectors = [
        'div[data-renderer="lm"]',
        '.prose[data-renderer="lm"]',
        '.prose[data-renderer]'
      ]

      const fallbackResponses = document.querySelectorAll(fallbackResponseSelectors.join(', '))
      console.log(`[PerplexityParser] Fallback response probe found ${fallbackResponses.length} elements`)

      fallbackResponses.forEach((node) => {
        appendResponse(node.textContent ?? '')
      })
    }

    return interactions
  }

  isResponseComplete(responseContent?: string): boolean {
    const responseContainer = this.findResponseContainerForContent(responseContent)
    if (!responseContainer) {
      return false
    }

    const copyActionSelector = this.resolveSelector('copyAction')
    if (!copyActionSelector) {
      return false
    }

    const busyIndicatorSelector = this.resolveSelector('busyIndicator')

    const hasCopyAction = responseContainer.querySelector(copyActionSelector) !== null
    const isBusy = busyIndicatorSelector
      ? responseContainer.querySelector(busyIndicatorSelector) !== null
      : false

    return hasCopyAction && !isBusy
  }

  /**
   * Extract sources cited in the response
   * Uses configured selectors to find all citation elements on page
   * Perplexity has specific citation data attributes for sources
   */
  async extractSources(responseContentOrContainer?: string | Element): Promise<SourceExtractionResult> {
    const responseContainer: Element | undefined = responseContentOrContainer instanceof Element
      ? responseContentOrContainer
      : this.findResponseContainerForContent(responseContentOrContainer)
    if (!responseContainer) {
      return { sources: [], source_extraction: 'terminal_empty' }
    }

    const currentResponseId = this.getCurrentResponseId(responseContainer)
    const questionForTurn = this.getQuestionForResponseContainer(responseContainer)

    // If a different turn's sources tabpanel is currently active, close it before
    // beginning extraction for this turn.
    const activePanelAtStart = this.findOpenSourcesPanel()
    if (activePanelAtStart && !this.panelMatchesQuestion(activePanelAtStart, questionForTurn)) {
      this.closeSourcesPanel(responseContainer)
      this.panelOpenedByParserForResponseId = undefined
    }

    // Some UI variants expose only close-button signals before tabpanel metadata is
    // available. If that stale panel is left open, the next toggle click can close
    // instead of open and cause a false extraction failure.
    if (!activePanelAtStart) {
      const configuredCloseSelector = this.resolveSelector('sourceCloseButton')
      const staleCloseButton = configuredCloseSelector
        ? document.querySelector(configuredCloseSelector) as HTMLElement | null
        : null
      if (staleCloseButton) {
        staleCloseButton.click()
        this.panelOpenedByParserForResponseId = undefined
      }
    }

    // Hard reset stale ownership when a new turn starts extraction.
    // This avoids ownership leakage across turns when a prior turn exited early.
    if (
      this.panelOpenedByParserForResponseId &&
      this.panelOpenedByParserForResponseId !== currentResponseId
    ) {
      this.closeSourcesPanel()
      this.panelOpenedByParserForResponseId = undefined
    }

    if (this.extractedResponseIds.has(currentResponseId)) {
      return { sources: [], source_extraction: 'terminal_empty' }
    }

    const sourceDetailSelector =
      this.resolveSelector('sourceDetailAnchors') ||
      this.resolveSelector('citationElements') ||
      'a[href*="http"], [data-pplx-citation-url]'

    const extractSourceGroupsFromPanel = (sourcePanel: Element): ExtractedSourceGroup[] => {
      const sources: ExtractedSource[] = []
      const visitedUrls = new Set<string>()
      const domainLabelByUrl = new Map<string, string>()

      const shouldSkipUrl = (url: string): boolean => {
        if (!url) return true
        if (url.startsWith('#') || url.startsWith('javascript:')) return true
        if (url.startsWith('/')) return true
        try {
          const hostname = new URL(url).hostname
          if (hostname.includes('perplexity.ai')) return true
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

      const citationElements = sourcePanel.querySelectorAll(sourceDetailSelector)
      citationElements.forEach((element) => {
        const url = element.getAttribute('data-pplx-citation-url') || element.getAttribute('href')
        if (!url || shouldSkipUrl(url)) return

        const titleElement = element.querySelector('span.font-medium.text-foreground.line-clamp-2, span.line-clamp-2')
        let title = this.normalizeText(titleElement?.textContent)

        const domainLabelElement = element.querySelector('span.text-quiet.text-xs.line-clamp-1')
        const domainLabel = this.normalizeText(domainLabelElement?.textContent)

        if (!title) {
          title = this.normalizeText(element.getAttribute('title') || element.getAttribute('aria-label'))
        }

        if (!title || !isValidTitle(title) || title.startsWith('http')) {
          try {
            title = new URL(url).hostname.replace(/^www\./, '')
          } catch {
            title = url
          }
        }

        visitedUrls.add(url)
        if (domainLabel) {
          domainLabelByUrl.set(url, domainLabel)
        }

        sources.push({
          source_title: title,
          source_url: url,
        })
      })

      if (sources.length === 0) {
        return []
      }

      const getBaseUrl = (url: string): string => {
        try {
          const parsed = new URL(url)
          return parsed.origin + parsed.pathname
        } catch {
          return url.split('#')[0]
        }
      }

      const seenBaseUrls = new Set<string>()
      const dedupedSources: ExtractedSource[] = []
      for (const source of sources) {
        if (!source.source_url) {
          continue
        }

        const base = getBaseUrl(source.source_url)
        if (seenBaseUrls.has(base)) {
          continue
        }

        seenBaseUrls.add(base)
        dedupedSources.push(source)
      }

      const sourceGroupMap = new Map<string, ExtractedSourceGroup>()
      for (const source of dedupedSources) {
        let domainName = ''
        try {
          domainName = source.source_url ? new URL(source.source_url).hostname.replace(/^www\./, '') : ''
        } catch {
          domainName = ''
        }

        const domainTitleFromLabel = source.source_url ? domainLabelByUrl.get(source.source_url) : undefined
        const domainTitle = domainTitleFromLabel || domainName || source.source_title || 'source'
        const groupKey = domainName || domainTitle

        if (!sourceGroupMap.has(groupKey)) {
          sourceGroupMap.set(groupKey, {
            domain_title: domainTitle,
            domain_name: domainName,
            sources: [],
          })
        }

        sourceGroupMap.get(groupKey)!.sources.push({
          source_title: source.source_title,
          source_url: source.source_url,
        })
      }

      return Array.from(sourceGroupMap.values())
    }

    const finalizeResult = (
      sources: ExtractedSourceGroup[],
      sourceExtraction: SourceExtractionClassification,
    ): SourceExtractionResult => {
      const activePanelForTurn = this.findOpenSourcesPanel(questionForTurn)
      if (activePanelForTurn) {
        this.closeSourcesPanel(responseContainer)
      }

      if (this.panelOpenedByParserForResponseId === currentResponseId) {
        this.panelOpenedByParserForResponseId = undefined
      }

      this.finalizeExtraction(responseContainer, currentResponseId, sourceExtraction)
      return {
        sources,
        source_extraction: sourceExtraction,
        close_panel: false,
      }
    }

    try {
      const maxAttempts = 2
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const sourceToggle = this.getSourceToggleInContainer(responseContainer)
        if (!sourceToggle) {
          if (attempt < maxAttempts) {
            continue
          }

          const inlineSourceCandidates = responseContainer.querySelectorAll(sourceDetailSelector).length > 0
          return finalizeResult([], inlineSourceCandidates ? 'data_capture_error' : 'none')
        }

        // Only click the toggle if the panel is not already open.
        // On attempt 2, the panel may still be visible from attempt 1's click (sources
        // render slowly); clicking the toggle again would close the already-open panel.
        const panelAlreadyVisible = !!this.findOpenSourcesPanel(questionForTurn)
        if (!panelAlreadyVisible) {
          if (!this.panelOpenedByParserForResponseId || this.panelOpenedByParserForResponseId === currentResponseId) {
            sourceToggle.click()
            this.panelOpenedByParserForResponseId = currentResponseId
          } else {
            return finalizeResult([], 'panel_opening_failure')
          }
        } else if (this.panelOpenedByParserForResponseId && this.panelOpenedByParserForResponseId !== currentResponseId) {
          // Panel is open but owned by a different turn — do not interfere.
          return finalizeResult([], 'panel_opening_failure')
        } else {
          // Panel is already open and we own it (or no ownership — claim it now).
          if (!this.panelOpenedByParserForResponseId) {
            this.panelOpenedByParserForResponseId = currentResponseId
          }
        }

        const sourcePanel = await this.waitForPanelVisible(questionForTurn)
        if (!sourcePanel) {
          if (attempt === maxAttempts) {
            return finalizeResult([], 'panel_opening_failure')
          }
          continue
        }

        if (this.panelOpenedByParserForResponseId && this.panelOpenedByParserForResponseId !== currentResponseId) {
          return finalizeResult([], 'panel_opening_failure')
        }

        const visibleSourceCountSignal = this.getVisibleSourceCountSignal(sourceToggle)
        const sourceDetailsSnapshot = await this.waitForSourceDetails(questionForTurn, sourceDetailSelector)
        const extractionPanel = sourceDetailsSnapshot.panel || sourcePanel
        const rawPanelAnchorCount = sourceDetailsSnapshot.detailCount
        console.log(
          `[PerplexityParser] Source attestation on attempt ${attempt}: ` +
          `button_signal=${visibleSourceCountSignal}, raw_panel_anchors=${rawPanelAnchorCount}`,
        )

        if (visibleSourceCountSignal > 0 && rawPanelAnchorCount === 0) {
          console.warn(
            `[PerplexityParser] Source attestation failed on attempt ${attempt}: ` +
            `button_signal=${visibleSourceCountSignal}, raw_panel_anchors=${rawPanelAnchorCount}`,
          )

          if (attempt < maxAttempts) {
            // Explicitly reset owned panel state before bounded retry.
            if (this.panelOpenedByParserForResponseId === currentResponseId) {
              this.closeSourcesPanel(responseContainer)
              this.panelOpenedByParserForResponseId = undefined
            }
            continue
          }

          return finalizeResult([], 'data_capture_error')
        }

        const sourceGroups = extractSourceGroupsFromPanel(extractionPanel)
        if (sourceGroups.length === 0 && visibleSourceCountSignal > 0) {
          console.warn(
            `[PerplexityParser] Source attestation mismatch on attempt ${attempt}: ` +
            `button_signal=${visibleSourceCountSignal}, extracted_groups=0`,
          )

          if (attempt < maxAttempts) {
            if (this.panelOpenedByParserForResponseId === currentResponseId) {
              this.closeSourcesPanel(responseContainer)
              this.panelOpenedByParserForResponseId = undefined
            }
            continue
          }

          return finalizeResult([], 'data_capture_error')
        }

        if (sourceGroups.length > 0) {
          const extractedUniqueCount = sourceGroups.reduce((count, group) => count + group.sources.length, 0)

          // Dedup-aware consistency: extracted unique URLs can be lower than the
          // visible source count signal, but should not collapse to a tiny subset.
          const minimumExpectedAfterDedup = visibleSourceCountSignal > 0
            ? Math.max(1, Math.floor(visibleSourceCountSignal * 0.6))
            : 0

          if (minimumExpectedAfterDedup > 0 && extractedUniqueCount < minimumExpectedAfterDedup) {
            console.warn(
              `[PerplexityParser] Source count mismatch on attempt ${attempt}: ` +
              `signal=${visibleSourceCountSignal}, extracted_unique=${extractedUniqueCount}, ` +
              `minimum_expected_after_dedup=${minimumExpectedAfterDedup}`,
            )

            if (attempt < maxAttempts) {
              // Reset panel state before the next retry so we don't keep reading
              // a stale/partial panel view.
              this.closeSourcesPanel(responseContainer)
              this.panelOpenedByParserForResponseId = undefined
              continue
            }

            return finalizeResult(sourceGroups, 'data_capture_error')
          }

          console.log(`[PerplexityParser] Extracted ${sourceGroups.length} source groups after attempt ${attempt}`)
          return finalizeResult(sourceGroups, 'success')
        }
      }

      return finalizeResult([], 'data_capture_error')
    } catch (error) {
      console.error('[PerplexityParser] Error resolving sources:', error)
      return finalizeResult([], 'data_capture_error')
    }
  }
}
