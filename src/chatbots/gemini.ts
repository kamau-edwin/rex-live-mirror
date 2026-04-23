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
  responseContainer?: string
  completeFooter?: string
  copyAction?: string
  busyIndicator?: string
  sourceAnchors?: string
  sourceButtons?: string
  sourceDetailAnchors?: string
  sourceToggleButton?: string
  sourceCloseButton?: string
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

export class GeminiParser {
  name = 'gemini'
  selectors: GeminiSelectors
  private fallbackMode: GeminiFallbackMode
  private selectorFallbacks: GeminiSelectorFallbacks
  private lastExtractedResponseId: string | undefined = undefined
  private panelOpenedByParserForResponseId: string | undefined = undefined
  private clickedSourceButtonsByResponse = new Map<string, Set<string>>()
  private selectorValidationError: string | null = null
  private responseContainerTimestamps = new Map<Element, number>()
  private lastResponseContainer: Element | undefined = undefined

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

  private isCitationSourceButton(button: Element): boolean {
    const aria = (button.getAttribute('aria-label') || '').toLowerCase()
    const dataTestId = (button.getAttribute('data-test-id') || '').toLowerCase()
    const className = (button.getAttribute('class') || '').toLowerCase()

    if (aria.includes('view source details')) {
      return true
    }

    if (dataTestId.includes('source') || dataTestId.includes('citation')) {
      return true
    }

    // Ignore generic controls like footer "Sources" toggle buttons.
    if (aria === 'sources' || className.includes('legacy-sources-sidebar-button')) {
      return false
    }

    return false
  }

  /**
   * Resolve a selector using configured fallback behavior.
   */
  private resolveSelector<K extends keyof GeminiSelectors>(key: K): string | undefined {
    const primary = this.selectors[key]?.trim()
    const fallbacks = (this.selectorFallbacks[key] || []).map((s) => s.trim()).filter(Boolean)

    if (this.fallbackMode === 'none') {
      return primary || undefined
    }

    if (this.fallbackMode === 'append') {
      const parts = [primary, ...fallbacks].filter(Boolean) as string[]
      return parts.length > 0 ? parts.join(', ') : undefined
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
    const responseContainerSelector = this.resolveSelector('responseContainer')
    if (!responseContainerSelector) {
      console.warn('[GeminiParser] Missing config selector: responseContainer')
      return false
    }

    const responseContainers = document.querySelectorAll(responseContainerSelector)
    if (responseContainers.length === 0) {
      return false
    }

    const latest = responseContainers[responseContainers.length - 1]
    const completeFooterSelector = this.resolveSelector('completeFooter')
    const copyActionSelector = this.resolveSelector('copyAction')
    const busyIndicatorSelector = this.resolveSelector('busyIndicator')

    if (!completeFooterSelector || !copyActionSelector || !busyIndicatorSelector) {
      console.warn(
        '[GeminiParser] Missing config selectors required for completion check: completeFooter, copyAction, busyIndicator',
      )
      return false
    }

    const hasCompleteFooter = latest.querySelector(completeFooterSelector) !== null
    const hasCopyAction = latest.querySelector(copyActionSelector) !== null
    const isBusy = latest.querySelector(busyIndicatorSelector) !== null

    if (hasCompleteFooter) {
      return true
    }

    return hasCopyAction && !isBusy
  }

  extractSources(): ExtractedSource[] {
    // Get all user interactions to extract latest question for response ID
    const interactions = this.extractInteractions()
    const latestQuestion = interactions
      .reverse()
      .find((i) => i.type === 'question')?.content

    // Get latest response container for querying source elements
    const responseContainerSelector = this.resolveSelector('responseContainer')
    if (!responseContainerSelector) {
      console.warn('[GeminiParser] Missing config selector: responseContainer')
      return []
    }

    const responseContainers = document.querySelectorAll(responseContainerSelector)
    const latestResponseContainer =
      responseContainers.length > 0 ? (responseContainers[responseContainers.length - 1] as Element) : undefined

    if (!latestResponseContainer) {
      console.warn('[GeminiParser] No response containers found')
      return []
    }

    // Assign timestamp to new response containers (one timestamp per question instance)
    if (!this.responseContainerTimestamps.has(latestResponseContainer)) {
      this.responseContainerTimestamps.set(latestResponseContainer, Date.now())
    }

    const containerTimestamp = this.responseContainerTimestamps.get(latestResponseContainer)!
    const currentResponseId = latestQuestion ? `${latestQuestion}:${containerTimestamp}` : undefined

    // Skip if we've already extracted sources for this response
    if (currentResponseId === this.lastExtractedResponseId) {
      console.log('[GeminiParser] Skipping source extraction - already completed for this response')
      return []
    }

    // Use latest response container to scope all DOM queries to this question's context
    this.lastResponseContainer = latestResponseContainer
    console.log('[GeminiParser] Config selectors:', {
      sourceAnchors: this.selectors.sourceAnchors,
      sourceButtons: this.selectors.sourceButtons,
      sourceDetailAnchors: this.selectors.sourceDetailAnchors,
      sourceToggleButton: this.selectors.sourceToggleButton,
      sourceCloseButton: this.selectors.sourceCloseButton,
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

    const maybeOpenSourcesPanel = (): boolean => {
      const toggleSelector = this.resolveSelector('sourceToggleButton')
      if (!toggleSelector) {
        console.warn('[GeminiParser] Missing config selector: sourceToggleButton')
        return false
      }
      const toggle = document.querySelector(toggleSelector) as HTMLElement | null
      if (!toggle) {
        console.warn(`[GeminiParser] Toggle button not found with selector: ${toggleSelector}`)
        return false
      }

      const className = toggle.getAttribute('class') || ''
      const alreadySelected = /\bselected\b/i.test(className)
      const ariaExpanded = (toggle.getAttribute('aria-expanded') || '').toLowerCase() === 'true'
      if (alreadySelected || ariaExpanded) {
        console.log('[GeminiParser] Sources panel already open, skipping toggle click')
        return false
      }

      // Immediate click - open sources panel for rapid extraction (sub-500ms total visible)
      toggle.click()
      console.log('[GeminiParser] Clicked sources toggle to reveal source URLs')
      return true
    }

    const removeSourcesPanelCss = (): void => {
      const styleId = 'gemini-sources-hidden'
      const style = document.getElementById(styleId)
      if (style) {
        style.remove()
        console.log('[GeminiParser] Removed CSS hide - sources panel can now be closed naturally')
      }
    }

    const queryWithinLatestTurn = (selector: string): Element[] => {
      if (!latestResponseContainer) {
        return []
      }
      return Array.from(latestResponseContainer.querySelectorAll(selector))
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

    // Source chips/buttons are also scoped to latest response turn.
    const sourceButtonSelector = this.resolveSelector('sourceButtons')
    const latestTurnSourceButtons = sourceButtonSelector ? queryWithinLatestTurn(sourceButtonSelector) : []
    const latestTurnCitationButtons = latestTurnSourceButtons.filter((button) => this.isCitationSourceButton(button))

    // Some Gemini turns expose sources only behind a footer Sources toggle button.
    const sourceToggleSelector = this.resolveSelector('sourceToggleButton')
    const hasFooterSourceToggleInLatestTurn = sourceToggleSelector
      ? queryWithinLatestTurn(sourceToggleSelector).length > 0
      : false

    // If latest turn has no source affordance at all, do not read side panel anchors (which can be stale).
    const hasSourceAffordanceInLatestTurn =
      latestTurnSourceAnchors.length > 0 ||
      latestTurnCitationButtons.length > 0 ||
      hasFooterSourceToggleInLatestTurn
    if (!hasSourceAffordanceInLatestTurn) {
      console.log('[GeminiParser] Latest response has no source affordance; returning empty sources for this turn')
      return []
    }

    // Additional source detail links are often rendered in side panels.
    const sourceDetailAnchorSelector = this.resolveSelector('sourceDetailAnchors')
    let sourceDetailAnchors: Element[] = []
    if (sourceDetailAnchorSelector) {
      sourceDetailAnchors = Array.from(document.querySelectorAll(sourceDetailAnchorSelector))
      console.log(
        `[GeminiParser] Found ${sourceDetailAnchors.length} source detail anchors with selector: ${sourceDetailAnchorSelector}`,
      )
    } else {
      console.warn('[GeminiParser] Missing config selector: sourceDetailAnchors')
    }

    let openedByParser = false
    if (sourceDetailAnchors.length === 0) {
      // Open panel only if source button exists
      console.log('[GeminiParser] No detail anchors found, checking for source button')
      openedByParser = maybeOpenSourcesPanel()
      
      if (openedByParser && currentResponseId) {
        this.panelOpenedByParserForResponseId = currentResponseId
        
        // Extract immediately - no waiting
        if (sourceDetailAnchorSelector) {
          sourceDetailAnchors = Array.from(document.querySelectorAll(sourceDetailAnchorSelector))
          console.log(`[GeminiParser] Extracted ${sourceDetailAnchors.length} detail anchors`)
        }
      }
    }
    sourceDetailAnchors.forEach((anchor) => {
      const url = extractUrlFromElement(anchor)
      if (!url) {
        return
      }

      const title =
        anchor.textContent?.replace(/\s+/g, ' ').trim() ||
        anchor.getAttribute('aria-label') ||
        undefined
      addSource(title, url)
    })

    // Fallback: capture source chip labels even when URL is not directly exposed.
    // NOTE: Exclude the toggle button (.legacy-sources-sidebar-button) — it's a control, not a source
    if (sourceButtonSelector) {
      latestTurnSourceButtons.forEach((button, index) => {
        const text = button.textContent?.replace(/\s+/g, ' ').trim() || ''
        const aria = button.getAttribute('aria-label')?.trim() || ''
        const label = text || aria || `source-${index + 1}`
        const url = extractUrlFromElement(button)
        addSource(label, url)
      })
    } else {
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

    const hasUrlSourceFinal = dedupedSources.some((source) => !!source.source_url)

    const closeSourcesPanelIfOpen = (): void => {
      const panelOpen =
        !!document.querySelector('context-sidebar:not([aria-hidden="true"])') ||
        !!document.querySelector('side-bar-sources:not([aria-hidden="true"])')
      if (!panelOpen) {
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

      // Fallback for UI variants where explicit close button selector changed.
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      console.log('[GeminiParser] Attempted to close sources panel via Escape fallback')
    }

    // Close panel after successful extraction whenever panel is open.
    if (hasUrlSourceFinal) {
      closeSourcesPanelIfOpen()
    }
    if (currentResponseId && this.panelOpenedByParserForResponseId === currentResponseId) {
      this.panelOpenedByParserForResponseId = undefined
    }

    // Only mark response as complete once we have at least one URL-backed source.
    if (hasUrlSourceFinal) {
      this.lastExtractedResponseId = currentResponseId
      if (currentResponseId) {
        this.clickedSourceButtonsByResponse.delete(currentResponseId)
      }
      console.log(`[GeminiParser] Response extraction complete (found ${dedupedSources.length} sources)`)
    } else {
      const clickedForResponse = currentResponseId ? this.clickedSourceButtonsByResponse.get(currentResponseId) : undefined
      const clickedCount = clickedForResponse?.size || 0
      const citationCandidateCount = latestTurnCitationButtons.length

      // Some Gemini responses legitimately have no sources. Finalize those turns with empty sources.
      if (
        citationCandidateCount === 0 &&
        sourceDetailAnchors.length === 0 &&
        latestTurnSourceAnchors.length === 0 &&
        !hasFooterSourceToggleInLatestTurn
      ) {
        this.lastExtractedResponseId = currentResponseId
        if (currentResponseId) {
          this.clickedSourceButtonsByResponse.delete(currentResponseId)
        }
        console.log('[GeminiParser] No source citations detected for this turn - finalizing with empty sources')
        return []
      }

      // Footer-only source turns: after one panel-open attempt for this turn, stop retrying forever.
      if (
        citationCandidateCount === 0 &&
        hasFooterSourceToggleInLatestTurn &&
        sourceDetailAnchors.length === 0
      ) {
        if (currentResponseId) {
          this.clickedSourceButtonsByResponse.delete(currentResponseId)
        }
        console.log('[GeminiParser] Footer sources toggle produced no URL links - finalizing with empty sources')
        return []
      }

      // If all citation chips have already been tried and no URL links emerged, stop retrying forever.
      if (citationCandidateCount > 0 && clickedCount >= citationCandidateCount && sourceDetailAnchors.length === 0) {
        this.lastExtractedResponseId = currentResponseId
        if (currentResponseId) {
          this.clickedSourceButtonsByResponse.delete(currentResponseId)
        }
        console.log('[GeminiParser] Citation chips exhausted without URL links - finalizing with empty sources')
        return []
      }

      console.log('[GeminiParser] No URL-backed sources found yet - will retry on next mutation')
    }

    return dedupedSources
  }
}
