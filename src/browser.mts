import { REXClientModule, registerREXModule } from '@bric/rex-core/browser'
import { PerplexityParser } from './chatbots/perplexity.js'
import { ChatGPTParser } from './chatbots/chatgpt.js'
import { GeminiParser } from './chatbots/gemini.js'
import { ClaudeParser } from './chatbots/claude.js'

export interface ExtractedSource {
  source_title: string
  source_url?: string
}

export interface LLMInteraction {
  interaction_id: string  // Unique ID for this specific interaction
  updates_interaction_id?: string  // If this extends a previous capture, reference to original
  source: string
  timestamp: number
  type: 'question' | 'response'
  content: string
  length: number
  url: string
  conversation_id?: string  // ChatGPT conversation ID (extracted from URL when available)
  sources?: ExtractedSource[]  // Citation sources extracted from response
  panelCycleConfirmed?: boolean  // MutationObserver validation: did panel open→close?
  panelCycleTimestamp?: { opened: number; closed: number; duration: number }  // Timing proof
}

/**
 * LLM Chatbot Module - Browser Context (Content Script)
 * Runs in page context on chatbot websites
 * Responsible for: DOM observation, Q&A extraction, data capture
 */
// Track captured content for update detection
interface CapturedInteractionInfo {
  interaction_id: string
  length: number
}

class LLMChatbotBrowserModule extends REXClientModule {
  private enabled: boolean = false
  private parser: any = null
  private mutationObserver: MutationObserver | null = null
  private interactions: LLMInteraction[] = []
  // Track responses pending source extraction: key = prefixKey, value = { interaction, createdAt, extractionAttempted }
  private pendingSourcesExtraction: Map<string, { interaction: LLMInteraction; createdAt: number; extractionAttempted: boolean }> = new Map()
  private readonly PENDING_SOURCES_TIMEOUT_MS = 5000  // Max 5s wait for sources before forcing transmission
  private pendingSourcesCheckTimer: ReturnType<typeof setInterval> | null = null
  private safetyTransmitTimer: ReturnType<typeof setInterval> | null = null
  // Track captured content by prefix for update detection
  // Key: type + first N chars (normalized), Value: { interaction_id, length }
  private capturedPrefixes: Map<string, CapturedInteractionInfo> = new Map()
  private readonly PREFIX_LENGTH = 100  // Characters to use for prefix matching
  private batchSize: number = 10
  private transmissionInterval: number = 60000
  private processDebounceTimer: ReturnType<typeof setTimeout> | null = null
  private readonly DEBOUNCE_MS = 500 // Wait 500ms after last DOM change before processing
  private currentConversationId: string | undefined = undefined  // Server-provided conversation ID from URL
  private lastCheckedUrl: string = ''  // Track URL to detect changes
  private localSessionId: string | undefined = undefined  // Self-generated ID for logged-out sessions
  private hadMessagesInDOM: boolean = false  // Track if we previously had messages (for new conversation detection)
  private lastSelectorDiagnosticFingerprint: string = ''

  constructor() {
    super()
    console.log('[LLM Chatbot Browser] Constructor called on:', window.location.href)
  }

  moduleName(): string {
    return 'LLMChatbotBrowserModule'
  }

  setup(): void {
    console.log('[LLM Chatbot Browser] Browser module initializing on:', window.location.href)

    // Get configuration from storage
    chrome.storage.local.get('REXConfiguration', (result) => {
      try {
        if (result.REXConfiguration) {
          const config = result.REXConfiguration
          const llmConfig = config['llm_capture']

          console.log('[LLM Chatbot Browser] Configuration loaded:', llmConfig)

          if (llmConfig?.enabled) {
            this.enabled = true
            this.batchSize = llmConfig.batch_size || 10
            this.transmissionInterval = llmConfig.transmission_interval_ms || 60000

            console.log('[LLM Chatbot Browser] Module enabled')
            console.log('[LLM Chatbot Browser] Batch size:', this.batchSize)
            console.log('[LLM Chatbot Browser] Transmission interval:', this.transmissionInterval, 'ms')

            // Determine which chatbot we're on
            this.initializeChatbotCapture(llmConfig)
          } else {
            console.log('[LLM Chatbot Browser] Module disabled in configuration')
          }
        } else {
          console.warn('[LLM Chatbot Browser] No configuration found')
        }
      } catch (error) {
        console.error('[LLM Chatbot Browser] Error loading configuration:', error)
      }
    })
  }

  private initializeChatbotCapture(llmConfig: any): void {
    const currentURL = window.location.href
    // Read sources from backend config, default to all if not specified
    const enabledSources = llmConfig.sources || []
    
    console.log('[LLM Chatbot Browser] Checking URL for chatbot:', currentURL)
    console.log('[LLM Chatbot Browser] Enabled sources from backend config:', enabledSources)

    // Only initialize if backend specifies sources to capture
    if (!enabledSources || enabledSources.length === 0) {
      console.log('[LLM Chatbot Browser] No sources configured in backend - skipping capture initialization')
      return
    }

    // Get platform-specific configs
    const platforms = llmConfig.platforms || {}

    // Match current page to chatbot source (only if source is enabled)
    try {
      if (enabledSources.includes('perplexity') && currentURL.includes('perplexity.ai')) {
        const perplexityConfig = platforms.perplexity || {}
        this.parser = new PerplexityParser(perplexityConfig)
        console.log('[LLM Chatbot Browser] Perplexity parser initialized with config')
      } else if (enabledSources.includes('chatgpt') && currentURL.includes('chatgpt.com')) {
        const chatgptConfig = platforms.chatgpt || {}
        this.parser = new ChatGPTParser(chatgptConfig)
        console.log('[LLM Chatbot Browser] ChatGPT parser initialized with config')
      } else if (enabledSources.includes('gemini') && currentURL.includes('gemini.google.com')) {
        const geminiConfig = platforms.gemini || {}
        this.parser = new GeminiParser(geminiConfig)
        console.log('[LLM Chatbot Browser] Gemini parser initialized with config')
      } else if (enabledSources.includes('claude') && currentURL.includes('claude.ai')) {
        const claudeConfig = platforms.claude || {}
        this.parser = new ClaudeParser(claudeConfig)
        console.log('[LLM Chatbot Browser] Claude parser initialized with config')
      } else {
        console.log('[LLM Chatbot Browser] No matching enabled chatbot parser for URL:', currentURL)
      }

      if (this.parser) {
        console.log(`[LLM Chatbot Browser] Parser initialized: ${this.parser.name}`)
        console.log(`[LLM Chatbot Browser] Parser selectors:`, this.parser.selectors || 'default')
        
        // Run selector validation for parser if available
        if (typeof this.parser.validateSelectors === 'function') {
          const validation = this.parser.validateSelectors()
          console.log(`[LLM Chatbot Browser] Selector validation: valid=${validation.valid}, questions=${validation.questionsFound}, responses=${validation.responsesFound}`)
          if (!validation.valid || (Array.isArray(validation.failures) && validation.failures.length > 0)) {
            this.reportSelectorDiagnostics(validation)
          }
        }
        
        this.startCapture()
      }
    } catch (error) {
      console.error('[LLM Chatbot Browser] Error initializing chatbot capture:', error)
    }
  }

  private reportSelectorDiagnostics(validation: any): void {
    try {
      const payload = {
        source: this.parser?.name || 'unknown',
        url: window.location.href,
        timestamp: Date.now(),
        selectors: this.parser?.selectors || {},
        validation,
      }

      const fingerprint = JSON.stringify({
        source: payload.source,
        url: payload.url,
        failures: validation?.failures || [],
      })

      if (fingerprint === this.lastSelectorDiagnosticFingerprint) {
        return
      }

      this.lastSelectorDiagnosticFingerprint = fingerprint

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(chrome.runtime.sendMessage as any)({
        messageType: 'llmSelectorDiagnostics',
        payload,
      })

      console.warn('[LLM Chatbot Browser] Reported selector diagnostics:', payload)
    } catch (error) {
      console.error('[LLM Chatbot Browser] Failed to report selector diagnostics:', error)
    }
  }

  private startCapture(): void {
    try {
      console.log('[LLM Chatbot Browser] Starting capture...')

      // Set up mutation observer for DOM changes with debouncing
      this.mutationObserver = new MutationObserver(() => {
        // Debounce: wait for DOM to settle before processing
        if (this.processDebounceTimer) {
          clearTimeout(this.processDebounceTimer)
        }
        this.processDebounceTimer = setTimeout(() => {
          try {
            this.processPage()
          } catch (error) {
            console.error('[LLM Chatbot Browser] Error in mutation observer callback:', error)
          }
        }, this.DEBOUNCE_MS)
      })

      // Observe the entire document for changes
      this.mutationObserver.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      })

      console.log('[LLM Chatbot Browser] DOM mutation observer started with debouncing')

      // Initial page processing (with small delay to let page settle)
      setTimeout(() => this.processPage(), 1000)

      // Removed: was causing continuous re-extraction loops
      // promoteReadyResponses() is now called directly when responses are added to pending queue

      // Safety fallback: Force transmission if items pending too long (every 10s)
      this.safetyTransmitTimer = setInterval(() => {
        try {
          if (this.interactions.length > 0) {
            console.log(`[LLM Chatbot Browser] Safety timer: ${this.interactions.length} interactions waiting, forcing transmission`)
            this.transmitBatch()
          }
          // Also force-promote stale pending responses (older than timeout)
          this.forcePromoteStalePendingResponses()
        } catch (error) {
          console.error('[LLM Chatbot Browser] Error in safety transmission:', error)
        }
      }, 10000)

      console.log('[LLM Chatbot Browser] Event-driven transmission started (sources check: 200ms, safety: 10s)')
    } catch (error) {
      console.error('[LLM Chatbot Browser] Error starting capture:', error)
    }
  }

  /**
   * Generate a prefix key for content matching and update detection
   * Uses type + normalized first N chars (ignoring length) to match content that may grow
   */
  private getPrefixKey(content: string, type: string): string {
    const normalized = content.trim().substring(0, this.PREFIX_LENGTH).replace(/\s+/g, ' ')
    return `${type}:${normalized}`
  }

  /**
   * Generate a unique interaction ID
   */
  private generateInteractionId(): string {
    return crypto.randomUUID()
  }

  /**
   * Keep only terminal interactions from update chains.
   * Any interaction referenced by updates_interaction_id is superseded.
   */
  private collapseSupersededInteractions(interactions: LLMInteraction[]): LLMInteraction[] {
    if (interactions.length === 0) {
      return interactions
    }

    const supersededIds = new Set<string>()
    for (const interaction of interactions) {
      if (interaction.updates_interaction_id) {
        supersededIds.add(interaction.updates_interaction_id)
      }
    }

    return interactions
      .filter((interaction) => !supersededIds.has(interaction.interaction_id))
      .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0))
  }

  /**
   * Extract conversation/search ID from chatbot URLs
   * - ChatGPT: chatgpt.com/c/{conversation-id} (UUID format)
   * - Perplexity: perplexity.ai/search/{query-slug}-{search-id} (base64-like ID at end)
   * - Claude: claude.ai/chat/{conversation-id} (UUID format)
   * - Gemini: gemini.google.com/u/{n}/app/{conversation-id} (hex string)
   */
  private extractConversationId(): string | undefined {
    const url = window.location.href
    
    // ChatGPT: Match conversation ID (UUID format)
    // Format: chatgpt.com/c/{uuid}
    if (url.includes('chatgpt.com')) {
      const match = url.match(/chatgpt\.com\/c\/([a-f0-9-]+)/i)
      return match ? match[1] : undefined
    }
    
    // Perplexity: Match search ID at end of URL path (base64url-like alphanumeric string)
    // Format: perplexity.ai/search/{query-slug}-{searchId}
    // The searchId is always the last segment after the final hyphen
    if (url.includes('perplexity.ai')) {
      // First extract just the path portion (before any ? or #)
      const pathMatch = url.match(/perplexity\.ai\/search\/([^?#]+)/)
      if (pathMatch) {
        const searchPath = pathMatch[1]
        // Extract the ID after the last hyphen (base64url format: letters, numbers, _, . - no hyphens)
        const idMatch = searchPath.match(/-([a-zA-Z0-9_.]{15,30})$/)
        if (idMatch) {
          return idMatch[1]
        }
      }
      return undefined
    }
    
    // Claude: Match conversation ID (UUID format)
    // Format: claude.ai/chat/{uuid}
    if (url.includes('claude.ai')) {
      const match = url.match(/claude\.ai\/chat\/([a-f0-9-]+)/i)
      return match ? match[1] : undefined
    }
    
    // Gemini: Match conversation ID (hex string)
    // Format: gemini.google.com/u/{n}/app/{hex-id}
    if (url.includes('gemini.google.com')) {
      const match = url.match(/gemini\.google\.com\/u\/\d+\/app\/([a-f0-9]+)/i)
      return match ? match[1] : undefined
    }
    
    return undefined
  }

  /**
   * Generate a local session ID for logged-out conversations
   * Prefixed with 'local-' to distinguish from server-provided IDs
   */
  private generateLocalSessionId(): string {
    return 'local-' + crypto.randomUUID()
  }

  /**
   * Get the effective conversation ID (server ID always supersedes local ID)
   */
  private getEffectiveConversationId(): string | undefined {
    return this.currentConversationId || this.localSessionId
  }

  /**
   * Check for URL changes and update conversation ID
   * Server-provided ID always supersedes local session ID
   * Also backfills pending interactions that don't have a conversation_id yet
   */
  private checkUrlChange(): void {
    const currentUrl = window.location.href
    
    // Skip if URL hasn't changed
    if (currentUrl === this.lastCheckedUrl) {
      return
    }
    
    this.lastCheckedUrl = currentUrl
    const newServerConversationId = this.extractConversationId()
    
    // If server conversation ID appeared, it supersedes any local session ID
    if (newServerConversationId && newServerConversationId !== this.currentConversationId) {
      console.log(`[LLM Chatbot Browser] Server conversation ID detected: ${newServerConversationId}`)
      
      // Clear local session ID since server ID takes precedence
      if (this.localSessionId) {
        console.log(`[LLM Chatbot Browser] Clearing local session ID (server ID supersedes)`)
        this.localSessionId = undefined
      }
      
      // Backfill any pending interactions with the server ID
      // This updates interactions that had local ID or no ID
      let backfilledCount = 0
      for (const interaction of this.interactions) {
        if (!interaction.conversation_id || interaction.conversation_id.startsWith('local-')) {
          interaction.conversation_id = newServerConversationId
          backfilledCount++
        }
      }
      
      if (backfilledCount > 0) {
        console.log(`[LLM Chatbot Browser] Backfilled conversation_id for ${backfilledCount} pending interactions`)
      }
    }
    
    this.currentConversationId = newServerConversationId
  }

  private processPage(): void {
    if (!this.parser) {
      console.debug('[LLM Chatbot Browser] No parser available, skipping page processing')
      return
    }

    try {
      // Check for URL changes and update conversation ID (backfills pending interactions)
      this.checkUrlChange()

      // Extract all current interactions from the page
      const newInteractions = this.parser.extractInteractions()
      const hasMessagesNow = newInteractions.length > 0

      // Detect new conversation: messages were cleared from DOM
      if (this.hadMessagesInDOM && !hasMessagesNow) {
        console.log('[LLM Chatbot Browser] Messages cleared from DOM - new conversation detected')
        // Reset for new conversation
        this.localSessionId = undefined
        this.capturedPrefixes.clear()
        this.currentConversationId = undefined
        this.lastCheckedUrl = ''  // Force URL re-check
      }
      
      // Update tracking state
      this.hadMessagesInDOM = hasMessagesNow

      if (newInteractions.length > 0) {
        console.log(`[LLM Chatbot Browser] Extracted ${newInteractions.length} interactions from page`)
      }

      // Check if we have any responses (not just questions)
      const hasResponse = newInteractions.some((i: { type: string }) => i.type === 'response')

      // Generate local session ID only if:
      // 1. No server conversation ID available
      // 2. We have a response (not just a prompt)
      // 3. We don't already have a local session ID
      if (!this.currentConversationId && hasResponse && !this.localSessionId) {
        this.localSessionId = this.generateLocalSessionId()
        console.log(`[LLM Chatbot Browser] Generated local session ID: ${this.localSessionId}`)
        
        // Backfill any pending interactions that don't have a conversation_id
        let backfilledCount = 0
        for (const interaction of this.interactions) {
          if (!interaction.conversation_id) {
            interaction.conversation_id = this.localSessionId
            backfilledCount++
          }
        }
        if (backfilledCount > 0) {
          console.log(`[LLM Chatbot Browser] Backfilled local session ID for ${backfilledCount} pending interactions`)
        }
      }

      let newCaptureCount = 0
      let updateCount = 0
      for (const interaction of newInteractions) {
        // For parsers that support completion checks (Gemini), avoid partial response capture.
        if (
          interaction.type === 'response' &&
          typeof this.parser.isResponseComplete === 'function' &&
          !this.parser.isResponseComplete()
        ) {
          continue
        }

        // Extract sources immediately if this is a response (don't wait until transmission)
        let extractedSources: ExtractedSource[] = []
        if (interaction.type === 'response' && typeof this.parser.extractSources === 'function') {
          try {
            // Check if sources button is available in DOM - button with class "legacy-sources-sidebar-button" 
            // contains the mat-icon with fonticon="link" when sources exist
            const sourcesButton = document.querySelector('button.legacy-sources-sidebar-button')
            
            if (sourcesButton) {
              extractedSources = this.parser.extractSources()
              if (extractedSources.length > 0) {
                console.log(`[LLM Chatbot Browser] Extracted ${extractedSources.length} sources immediately for response (sources button detected in DOM)`)
                // Close the sources panel after extraction completes
                if (typeof this.parser.closeSourcesPanel === 'function') {
                  this.parser.closeSourcesPanel()
                }
              }
            } else {
              console.log(`[LLM Chatbot Browser] Response detected but sources button not yet available in DOM`)
            }
          } catch (error) {
            console.error('[LLM Chatbot Browser] Error extracting sources immediately:', error)
          }
        }

        // Generate prefix key for this content
        const prefixKey = this.getPrefixKey(interaction.content, interaction.type)
        const currentLength = interaction.content.length
        const existingCapture = this.capturedPrefixes.get(prefixKey)

        if (existingCapture) {
          // Same prefix already captured
          if (currentLength <= existingCapture.length) {
            // Same or shorter content - skip (duplicate or subset)
            continue
          }

          // Longer content - this is an update of the previous capture
          const newId = this.generateInteractionId()
          const newInteraction: LLMInteraction = {
            interaction_id: newId,
            updates_interaction_id: existingCapture.interaction_id,  // Reference original
            source: this.parser.name,
            timestamp: Date.now(),
            type: interaction.type,
            content: interaction.content,
            length: currentLength,
            url: window.location.href,
            conversation_id: this.getEffectiveConversationId(),
            sources: interaction.type === 'response' ? extractedSources : [],
          }
          if (newInteraction.type === 'response') {
            console.log(`[LLM Chatbot Browser] Response update created with ${newInteraction.sources?.length || 0} sources`)
          }

          // Update the map with new ID and length
          this.capturedPrefixes.set(prefixKey, { interaction_id: newId, length: currentLength })
          this.interactions.push(newInteraction)
          updateCount++

          console.log(
            `[LLM Chatbot Browser] Updated ${interaction.type} (${existingCapture.length} -> ${currentLength} chars): ${interaction.content.substring(0, 50)}...`,
          )
        } else {
          // New content - first capture
          const newId = this.generateInteractionId()
          const newInteraction: LLMInteraction = {
            interaction_id: newId,
            source: this.parser.name,
            timestamp: Date.now(),
            type: interaction.type,
            content: interaction.content,
            length: currentLength,
            url: window.location.href,
            conversation_id: this.getEffectiveConversationId(),
            sources: interaction.type === 'response' ? extractedSources : [],
          }
          if (newInteraction.type === 'response') {
            console.log(`[LLM Chatbot Browser] Response created with ${newInteraction.sources?.length || 0} sources`)
          }

          this.capturedPrefixes.set(prefixKey, { interaction_id: newId, length: currentLength })
          
          // For responses without sources extracted, hold only for parsers that use a source toggle panel (Gemini).
          const hasPanelSourceToggle = !!this.parser?.selectors?.sourceToggleButton
          if (
            newInteraction.type === 'response' &&
            hasPanelSourceToggle &&
            (!newInteraction.sources || newInteraction.sources.length === 0)
          ) {
            console.log(`[LLM Chatbot Browser] Response deferred to pending queue (will attempt extraction once)`)
            this.pendingSourcesExtraction.set(prefixKey, { 
              interaction: newInteraction, 
              createdAt: Date.now(),
              extractionAttempted: false
            })
            // Immediately attempt extraction (single pass, no timer loop)
            this.promoteReadyResponses()
          } else {
            // Questions or responses with sources go directly to transmission queue
            this.interactions.push(newInteraction)
            // Check if we should transmit now (batch full or ready to send)
            if (this.interactions.length >= this.batchSize) {
              console.log(`[LLM Chatbot Browser] Batch full (${this.interactions.length}), triggering transmission`)
              this.transmitBatch()
            }
          }
          
          newCaptureCount++

          console.log(
            `[LLM Chatbot Browser] Captured ${interaction.type}: ${interaction.content.substring(0, 50)}...`,
          )
        }
      }

      if (newCaptureCount > 0 || updateCount > 0) {
        console.log(`[LLM Chatbot Browser] Captured ${newCaptureCount} new, ${updateCount} updates (${this.capturedPrefixes.size} total unique)`)
      }
      console.debug(`[LLM Chatbot Browser] Pending for transmission: ${this.interactions.length}`)
    } catch (error) {
      console.error('[LLM Chatbot Browser] Error processing page:', error)
    }
  }

  /**
   * Check pending responses and promote when sources are ready to extract.
   * Sources button appears after response is fully rendered, so checking for
   * sources button visibility is sufficient. Extraction attempted only once per response.
   * Also collects MutationObserver panel lifecycle validation.
   */
  private promoteReadyResponses(): void {
    const now = Date.now()
    const toRemove: string[] = []
    let promotedCount = 0

    for (const [prefixKey, pending] of this.pendingSourcesExtraction.entries()) {
      const timePending = now - pending.createdAt
      
      // Check if sources button is visible (sources ready to extract) for panel-based parsers only.
      const sourcesButtonSelector = this.parser?.selectors?.sourceToggleButton

      // Non-panel chatbots (no sourceToggleButton configured) should not wait on Gemini-specific selectors.
      if (!sourcesButtonSelector) {
        this.interactions.push(pending.interaction)
        promotedCount++
        toRemove.push(prefixKey)
        console.log('[LLM Chatbot Browser] No source toggle selector for parser - promoting response immediately')

        if (this.interactions.length >= this.batchSize) {
          console.log(`[LLM Chatbot Browser] Batch full after promotion, triggering transmission`)
          this.transmitBatch()
        }
        continue
      }

      const sourcesButtonVisible = !!document.querySelector(sourcesButtonSelector)
      
      // Wait for sources button to become visible
      if (!sourcesButtonVisible) {
        continue // Not ready yet, skip this response
      }
      
      // Attempt extraction ONCE when sources button becomes visible
      if (!pending.extractionAttempted) {
        pending.extractionAttempted = true
        
        // Start panel lifecycle observer (runs concurrently with extraction)
        // This validates that panel opens→closes during extraction
        const panelCyclePromise = this.watchPanelLifecycle(pending.interaction.interaction_id, 500)
        
        if (this.parser && typeof this.parser.extractSources === 'function') {
          try {
            const updatedSources = this.parser.extractSources()
            if (updatedSources && updatedSources.length > 0) {
              pending.interaction.sources = updatedSources
              console.log(
                `[LLM Chatbot Browser] Extracted ${updatedSources.length} sources (waited ${timePending}ms)`,
              )
            } else {
              console.log(`[LLM Chatbot Browser] No sources found despite button visible (waited ${timePending}ms)`)
            }
          } catch (error) {
            console.error(`[LLM Chatbot Browser] Error extracting sources:`, error)
          }
        }

        // Attach panel cycle result (will resolve within extraction window or timeout)
        // Don't wait for it - attach whenever it resolves
        panelCyclePromise.then((result) => {
          pending.interaction.panelCycleConfirmed = result.confirmed
          if (result.timing) {
            pending.interaction.panelCycleTimestamp = result.timing
            console.log(
              `[LLM Chatbot Browser] Panel cycle validated: open→close in ${result.timing.duration}ms`,
            )
          }
        }).catch((err) => {
          console.error(`[LLM Chatbot Browser] Panel observation error:`, err)
        })
      }
      
      // Promote to transmission queue (sources may be empty or populated, both okay)
      this.interactions.push(pending.interaction)
      promotedCount++
      toRemove.push(prefixKey)
      console.log(
        `[LLM Chatbot Browser] Promoted response to transmission (${pending.interaction.sources?.length || 0} sources, panel cycle: ${pending.interaction.panelCycleConfirmed !== undefined ? pending.interaction.panelCycleConfirmed : 'pending'})`,
      )
      
      // Check if batch full after promotion
      if (this.interactions.length >= this.batchSize) {
        console.log(`[LLM Chatbot Browser] Batch full after promotion, triggering transmission`)
        this.transmitBatch()
      }
    }

    // Clean up promoted responses
    for (const key of toRemove) {
      this.pendingSourcesExtraction.delete(key)
    }
    
    if (promotedCount > 0) {
      console.log(`[LLM Chatbot Browser] Promoted ${promotedCount} responses (sources button detected)`)
    }
  }

  /**
   * Force-promote responses that have been waiting >5s even if no sources found
   * This prevents stalled responses from blocking transmission forever
   */
  private forcePromoteStalePendingResponses(): void {
    const now = Date.now()
    const toRemove: string[] = []
    let forcedCount = 0

    for (const [prefixKey, pending] of this.pendingSourcesExtraction.entries()) {
      const timePending = now - pending.createdAt

      // If waiting longer than timeout, force promote even without sources
      if (timePending > this.PENDING_SOURCES_TIMEOUT_MS) {
        console.log(`[LLM Chatbot Browser] FORCE-PROMOTED: Response waited ${timePending}ms (timeout), promoting without sources`)
        this.interactions.push(pending.interaction)
        forcedCount++
        toRemove.push(prefixKey)
        
        // Check if batch full after promotion
        if (this.interactions.length >= this.batchSize) {
          console.log(`[LLM Chatbot Browser] Batch full after force-promotion, triggering transmission`)
          this.transmitBatch()
        }
      }
    }

    // Clean up force-promoted responses
    for (const key of toRemove) {
      this.pendingSourcesExtraction.delete(key)
    }
  }

  /**
   * Watch for sources panel open→close cycle using MutationObserver.
   * Returns validation result and timing proof without capturing data.
   * MO responsibility: Confirm panel lifecycle, not extract content.
   */
  private async watchPanelLifecycle(
    responseId: string,
    timeoutMs: number = 500,
  ): Promise<{ confirmed: boolean; timing?: { opened: number; closed: number; duration: number } }> {
    return new Promise((resolve) => {
      const panelSelector = this.parser?.selectors?.sourceToggleButton || 'button.legacy-sources-sidebar-button'
      const containerSelector = this.parser?.selectors?.responseContainer || '.conversation-container model-response'
      
      let panelOpenTime: number | null = null
      let resolved = false

      // Timeout fallback
      const timeoutHandle = setTimeout(() => {
        if (!resolved) {
          resolved = true
          observer.disconnect()
          console.log(`[LLM Chatbot Browser] Panel lifecycle timeout (${timeoutMs}ms): no open→close observed`)
          resolve({ confirmed: false })
        }
      }, timeoutMs)

      const observer = new MutationObserver((mutations) => {
        if (resolved) return

        for (const mutation of mutations) {
          // Check for panel container addition
          if (mutation.type === 'childList' && mutation.target instanceof Element) {
            // Panel opening: check if sources container appeared
            const containers = (mutation.target as Element).querySelectorAll('[class*="sources"], [class*="sidebar"]')
            if (containers.length > 0 && !panelOpenTime) {
              panelOpenTime = Date.now()
              console.log(`[LLM Chatbot Browser] Panel open detected (MO): ${responseId}`)
            }

            // Panel closing: check if sources container was removed
            if (panelOpenTime && containers.length === 0) {
              const closedTime = Date.now()
              resolved = true
              observer.disconnect()
              clearTimeout(timeoutHandle)

              console.log(`[LLM Chatbot Browser] Panel close detected (MO): ${responseId}`)
              resolve({
                confirmed: true,
                timing: {
                  opened: panelOpenTime,
                  closed: closedTime,
                  duration: closedTime - panelOpenTime,
                },
              })
            }
          }
        }
      })

      // Start observing the response container for panel add/remove
      const container = document.querySelector(containerSelector)
      if (container) {
        observer.observe(container, {
          childList: true,
          subtree: true,
          attributes: false,
          characterData: false,
        })
      } else {
        console.warn(`[LLM Chatbot Browser] Could not find response container for panel observation: ${containerSelector}`)
        resolved = true
        resolve({ confirmed: false })
      }
    })
  }

  private sendBatchWithRetry(batch: LLMInteraction[], attempt: number = 1): void {
    const MAX_RETRIES = 3
    const RETRY_DELAY_MS = 2000 // 2s delay gives the service worker time to finish initializing

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(chrome.runtime.sendMessage as any)(
      {
        messageType: 'llmInteractionsBatch',
        interactions: batch,
      },
      () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const lastError = (chrome.runtime as any).lastError
        if (lastError) {
          const errorMsg = lastError.message || JSON.stringify(lastError)
          console.warn(`[LLM Chatbot Browser] sendMessage failed (attempt ${attempt}/${MAX_RETRIES}): ${errorMsg}`)

          if (attempt < MAX_RETRIES) {
            setTimeout(() => this.sendBatchWithRetry(batch, attempt + 1), RETRY_DELAY_MS)
          } else {
            console.error(`[LLM Chatbot Browser] All ${MAX_RETRIES} attempts failed, re-queuing ${batch.length} interactions for next cycle`)
            // Put the batch back at the front of the queue so the next transmitBatch() picks it up
            this.interactions = [...batch, ...this.interactions]
          }
        } else {
          console.log('[LLM Chatbot Browser] Batch sent to service worker successfully')
        }
      }
    )
  }

  private transmitBatch(): void {
    try {
      if (this.interactions.length === 0) {
        console.debug('[LLM Chatbot Browser] No interactions to transmit')
        return
      }

      // Only transmit interactions that have a conversation_id
      // Keep ones without an ID for later backfilling when we get a response
      const readyToTransmit: LLMInteraction[] = []
      const needsBackfill: LLMInteraction[] = []

      for (const interaction of this.interactions) {
        if (interaction.conversation_id) {
          readyToTransmit.push(interaction)
        } else {
          needsBackfill.push(interaction)
        }
      }

      // Keep interactions that need backfilling, clear the ones we're transmitting
      this.interactions = needsBackfill

      if (readyToTransmit.length === 0) {
        console.debug(`[LLM Chatbot Browser] ${needsBackfill.length} interactions waiting for conversation_id`)
        return
      }

      const finalizedInteractions = this.collapseSupersededInteractions(readyToTransmit)

      if (finalizedInteractions.length !== readyToTransmit.length) {
        console.log(
          `[LLM Chatbot Browser] Collapsed ${readyToTransmit.length - finalizedInteractions.length} superseded interactions before transmission`,
        )
      }

      // Get batch to transmit (respect batch size)
      const batch = finalizedInteractions.slice(0, this.batchSize)
      // Put any overflow back into the queue (at the front, since they're ready)
      if (finalizedInteractions.length > this.batchSize) {
        this.interactions = [...finalizedInteractions.slice(this.batchSize), ...this.interactions]
      }

      console.log(`[LLM Chatbot Browser] Transmitting batch of ${batch.length} interactions via message (${needsBackfill.length} waiting for ID)`)

      // Send with retry to handle service worker restart race condition.
      // After a restart, modules register asynchronously; messages arriving
      // before registration complete get dropped ("message port closed").
      this.sendBatchWithRetry(batch)
    } catch (error) {
      console.error('[LLM Chatbot Browser] Error transmitting batch:', error)
    }
  }

  checkRequirement(requirement: string): Promise<boolean> {
    console.debug(`[LLM Chatbot Browser] Checking requirement: ${requirement}`)
    return Promise.resolve(this.enabled)
  }
}

const llmChatbotModule = new LLMChatbotBrowserModule()
registerREXModule(llmChatbotModule)

console.log('[LLM Chatbot Browser] Module registered and ready')

export default llmChatbotModule
