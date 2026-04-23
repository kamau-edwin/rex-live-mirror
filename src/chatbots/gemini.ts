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
  private lastExtractedResponseId: string | undefined = undefined

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
    // Get current response ID to detect if we're processing a new response
    const responseContainers = document.querySelectorAll('.conversation-container model-response')
    const currentResponseId = responseContainers.length > 0 ? `${responseContainers.length}` : undefined

    // Skip if we've already extracted sources for this response
    if (currentResponseId === this.lastExtractedResponseId) {
      console.log('[GeminiParser] Skipping source extraction - already completed for this response')
      return []
    }

    console.log(`[GeminiParser] Starting source extraction for response (ID: ${currentResponseId})`)

    const sources: ExtractedSource[] = []
    const seen = new Set<string>()

    console.log('[GeminiParser] Starting source extraction')
    console.log('[GeminiParser] Config selectors:', {
      sourceAnchors: this.selectors.sourceAnchors,
      sourceButtons: this.selectors.sourceButtons,
      sourceDetailAnchors: this.selectors.sourceDetailAnchors,
      sourceToggleButton: this.selectors.sourceToggleButton,
      sourceCloseButton: this.selectors.sourceCloseButton,
    })

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
      const toggleSelector = this.selectors.sourceToggleButton || '.legacy-sources-sidebar-button'
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

      toggle.click()
      console.log('[GeminiParser] Clicked sources toggle to reveal source URLs')
      return true
    }

    const closeSourcesPanel = (): void => {
      // Add a small delay to ensure panel DOM is fully rendered
      setTimeout(() => {
        // Try multiple close button selectors for robustness
        const selectors = [
          'context-sidebar button[data-test-id="close-button"]',
          'context-sidebar button[aria-label="Close sidebar"]',
          'context-sidebar button[aria-label*="close" i]',
          '.legacy-sources-sidebar button[aria-label*="close" i]',
          'button[data-test-id="close-button"]',
        ]

        let closeButton: HTMLElement | null = null
        for (const selector of selectors) {
          closeButton = document.querySelector(selector) as HTMLElement | null
          if (closeButton) {
            console.log(`[GeminiParser] Found close button with selector: ${selector}`)
            break
          }
        }

        if (!closeButton) {
          console.warn('[GeminiParser] Could not find close button for sources sidebar')
          return
        }

        closeButton.click()
        console.log('[GeminiParser] Clicked to close sources sidebar after extraction')
      }, 200)
    }

    // Prefer explicit source links when present.
    const sourceAnchorSelector =
      this.selectors.sourceAnchors || '.conversation-container model-response a[href^="http"]'
    const sourceAnchors = document.querySelectorAll(sourceAnchorSelector)
    sourceAnchors.forEach((anchor) => {
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

    // Additional source detail links are often rendered in side panels.
    const sourceDetailAnchorSelector =
      this.selectors.sourceDetailAnchors ||
      '.legacy-sources-sidebar a[href], .legacy-source-card a[href], [aria-label*="source details" i] a[href]'
    let sourceDetailAnchors = document.querySelectorAll(sourceDetailAnchorSelector)
    console.log(
      `[GeminiParser] Found ${sourceDetailAnchors.length} source detail anchors with selector: ${sourceDetailAnchorSelector}`,
    )

    let openedByParser = false
    if (sourceDetailAnchors.length === 0) {
      // Gemini may require opening the Sources panel before detail links are rendered.
      console.log('[GeminiParser] No detail anchors found, attempting to open sources panel')
      openedByParser = maybeOpenSourcesPanel()
      
      if (openedByParser) {
        // Wait for panel to render before re-querying
        console.log('[GeminiParser] Panel opened by parser, detail anchors will be queried on next extraction attempt')
      } else {
        // Panel was already open, so query again immediately
        sourceDetailAnchors = document.querySelectorAll(sourceDetailAnchorSelector)
        console.log(
          `[GeminiParser] Panel was already open, found ${sourceDetailAnchors.length} source detail anchors`,
        )
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
    const sourceButtonSelector =
      this.selectors.sourceButtons ||
      '.conversation-container model-response sources-list button, .conversation-container model-response source-inline-chip button, [aria-label*="View source details for citation from"]'
    const sourceButtons = document.querySelectorAll(sourceButtonSelector)
    sourceButtons.forEach((button, index) => {
      const text = button.textContent?.replace(/\s+/g, ' ').trim() || ''
      const aria = button.getAttribute('aria-label')?.trim() || ''
      const label = text || aria || `source-${index + 1}`
      const url = extractUrlFromElement(button)
      addSource(label, url)
    })

    if (openedByParser && sources.length > 0) {
      closeSourcesPanel()
    } else if (openedByParser) {
      console.log('[GeminiParser] Panel opened but no sources found yet - keeping panel open for retry')
    }

    console.log(`[GeminiParser] Extracted ${sources.length} sources`)
    
    // Only mark response as "fully processed" if we found sources or didn't need to open panel
    // If we opened the panel but found nothing, allow re-extraction on next mutation
    if (sources.length > 0 || !openedByParser) {
      this.lastExtractedResponseId = currentResponseId
      console.log(`[GeminiParser] Response extraction complete (found ${sources.length} sources)`)
    } else {
      console.log('[GeminiParser] Opened panel but found no sources yet - will retry on next mutation')
    }
    
    return sources
  }
}
