import { REXClientModule, registerREXModule } from '@bric/rex-core/browser'
import { initializePageActionPipeline } from '@bric/rex-page-events/page-actions'
import { PerplexityParser, type SourceExtractionResult } from './chatbots/perplexity.js'
import { ChatGPTParser, type ChatGPTCompletionDecision } from './chatbots/chatgpt.js'
import { GeminiParser } from './chatbots/gemini.js'
import { ClaudeParser } from './chatbots/claude.js'
import { pageHtmlCaptureModule as pageCaptureModule } from './page-html-capture/browser.mjs'

export interface ExtractedSource {
  source_title: string
  source_url?: string
}

export interface ExtractedSourceGroup {
  domain_title: string
  domain_name: string
  sources: ExtractedSource[]
}

export interface LLMInteraction {
  interaction_id: string  // Unique ID for this specific interaction
  updates_interaction_id?: string  // If this extends a previous capture, reference to original
  source: string
  timestamp: number
  type: 'question' | 'response'
  content: string
  question_timestamp?: number  // Stable timestamp emitted by parser for repeated identical questions
  length: number
  url: string
  conversation_id?: string  // ChatGPT conversation ID (extracted from URL when available)
  turn_number?: number  // 1-based ordinal for this interaction type in the current parsed snapshot
  sources?: (ExtractedSource | ExtractedSourceGroup)[]  // Citation sources extracted from response
  source_extraction?: 'success' | 'failed' | 'none' | 'terminal_empty' | 'data_capture_error' | 'panel_opening_failure'
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

interface PendingSourceExtractionInfo {
  interaction: LLMInteraction
  containerRef?: Element
  turnRetryObserver?: MutationObserver
  unresolvedRetryCount: number
}

class LLMChatbotBrowserModule extends REXClientModule {
  private enabled: boolean = false
  private parser: any = null
  private mutationObserver: MutationObserver | null = null
  private interactions: LLMInteraction[] = []
  // Track responses pending source extraction: key = prefixKey, value = { interaction, containerRef, turnRetryObserver }
  // containerRef pins extraction to the original turn element, avoiding stale content matching during later promotions.
  private pendingSourcesExtraction: Map<string, PendingSourceExtractionInfo> = new Map()
  private sourceRetryExhaustedKeys: Set<string> = new Set()
  // Track captured content by prefix for update detection
  // Key: type + first N chars (normalized), Value: { interaction_id, length }
  private capturedPrefixes: Map<string, CapturedInteractionInfo> = new Map()
  private readonly PREFIX_LENGTH = 100  // Characters to use for prefix matching
  private readonly MAX_PENDING_SOURCE_RETRIES = 8
  private batchSize: number = 10
  private transmissionInterval: number = 60000
  private processDebounceTimer: ReturnType<typeof setTimeout> | null = null
  private readonly DEBOUNCE_MS = 500 // Wait 500ms after last DOM change before processing
  private currentConversationId: string | undefined = undefined  // Server-provided conversation ID from URL
  private lastCheckedUrl: string = ''  // Track URL to detect changes
  private localSessionId: string | undefined = undefined  // Self-generated ID for logged-out sessions
  private hadMessagesInDOM: boolean = false  // Track if we previously had messages (for new conversation detection)
  private emptyDomSinceMs: number | null = null
  private readonly EMPTY_DOM_RESET_GRACE_MS = 8000
  private lastSelectorDiagnosticFingerprint: string = ''
  private responseContainerKeys = new Map<Element, string>()
  private responseContainerKeySequence = 0
  private completionRecheckTimers: Map<string, ReturnType<typeof setTimeout>> = new Map()
  private completionRecheckAttempts: Map<string, number> = new Map()
  private readonly MAX_COMPLETION_RECHECK_ATTEMPTS = 3
  private readonly COMPLETION_RECHECK_DELAY_MS = 300
  private processInFlight: boolean = false
  private processQueued: boolean = false

  // Browser-side persistence checkpoint — prevents re-capture of already-sent prompts across page reloads.
  private captureCheckpointMaxQts: number = 0                  // max question_timestamp seen
  private captureCheckpointLoaded: boolean = false             // gate: no processPage until loaded
  private checkpointPersistTimer: ReturnType<typeof setTimeout> | null = null
  private readonly CHECKPOINT_KEY_PREFIX = 'llm_capture_checkpoint_v1'
  private readonly CHECKPOINT_TTL_MS = 8 * 60 * 60 * 1000     // 8 hours
  private readonly CHECKPOINT_MAX_KEYS = 500

  constructor() {
    super()
    console.log('[LLM Chatbot Browser] Constructor called on:', window.location.href)
  }

  moduleName(): string {
    return 'LLMChatbotBrowserModule'
  }

  setup(): void {
    console.log('[LLM Chatbot Browser] Browser module initializing on:', window.location.href)

    const singletonKey = '__rex_llm_chatbot_browser_instance_active__'
    const globalWindow = window as typeof window & Record<string, unknown>
    if (globalWindow[singletonKey]) {
      console.log('[LLM Chatbot Browser] Skipping duplicate initialization in current page context')
      return
    }
    globalWindow[singletonKey] = true

    // Avoid duplicate capture pipelines from embedded frames.
    if (window.top !== window.self) {
      console.log('[LLM Chatbot Browser] Skipping initialization in non-top frame')
      return
    }

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

            initializePageActionPipeline()

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

  private normalizeStringArray(input: unknown): string[] {
    if (!Array.isArray(input)) {
      return []
    }

    return input
      .map((value) => (typeof value === 'string' ? value.trim().toLowerCase() : ''))
      .filter((value) => value.length > 0)
  }

  private coerceBoolean(value: unknown): boolean {
    if (typeof value === 'boolean') {
      return value
    }
    if (typeof value === 'string') {
      return value.trim().toLowerCase() === 'true'
    }
    return Boolean(value)
  }

  private isPlatformEnabled(platformConfig: any): boolean { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (typeof platformConfig?.enabled === 'boolean') {
      return platformConfig.enabled
    }

    return true
  }

  private getConfiguredHosts(platformConfig: any, defaults: string[]): string[] { // eslint-disable-line @typescript-eslint/no-explicit-any
    const configuredHosts = this.normalizeStringArray(platformConfig?.hosts)
    if (configuredHosts.length > 0) {
      return configuredHosts
    }

    return defaults.map((host) => host.trim().toLowerCase()).filter(Boolean)
  }

  private hostMatchesConfiguredHosts(host: string, allowedHosts: string[]): boolean {
    const normalizedHost = host.trim().toLowerCase()
    return allowedHosts.includes(normalizedHost)
  }

  private initializeChatbotCapture(llmConfig: any): void {
    const currentURL = window.location.href
    const currentLocation = new URL(currentURL)
    const host = currentLocation.hostname
    const path = currentLocation.pathname
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
    const perplexityConfig = platforms.perplexity || {}
    const chatgptConfig = platforms.chatgpt || {}
    const geminiConfig = platforms.gemini || {}
    const claudeConfig = platforms.claude || {}

    const perplexityHosts = this.getConfiguredHosts(perplexityConfig, ['www.perplexity.ai', 'perplexity.ai'])
    const chatgptHosts = this.getConfiguredHosts(chatgptConfig, ['chatgpt.com'])
    const geminiHosts = this.getConfiguredHosts(geminiConfig, ['gemini.google.com'])
    const claudeHosts = this.getConfiguredHosts(claudeConfig, ['claude.ai'])

    const geminiCaptureEligible = this.isGeminiCaptureEligiblePath(path, geminiConfig)

    // Match current page to chatbot source (only if source is enabled)
    try {
      if (
        enabledSources.includes('perplexity') &&
        this.isPlatformEnabled(perplexityConfig) &&
        this.hostMatchesConfiguredHosts(host, perplexityHosts)
      ) {
        this.parser = new PerplexityParser(perplexityConfig)
        console.log('[LLM Chatbot Browser] Perplexity parser initialized with config')
      } else if (
        enabledSources.includes('chatgpt') &&
        this.isPlatformEnabled(chatgptConfig) &&
        this.hostMatchesConfiguredHosts(host, chatgptHosts)
      ) {
        this.parser = new ChatGPTParser(chatgptConfig)
        console.log('[LLM Chatbot Browser] ChatGPT parser initialized with config')
      } else if (
        enabledSources.includes('gemini') &&
        this.isPlatformEnabled(geminiConfig) &&
        this.hostMatchesConfiguredHosts(host, geminiHosts) &&
        geminiCaptureEligible
      ) {
        this.parser = new GeminiParser(geminiConfig)
        console.log('[LLM Chatbot Browser] Gemini parser initialized with config')
      } else if (
        enabledSources.includes('claude') &&
        this.isPlatformEnabled(claudeConfig) &&
        this.hostMatchesConfiguredHosts(host, claudeHosts)
      ) {
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
        
        this.loadCaptureCheckpoint().then(() => this.startCapture())
      }
    } catch (error) {
      console.error('[LLM Chatbot Browser] Error initializing chatbot capture:', error)
    }
  }

  private isGeminiCaptureEligiblePath(path: string, geminiConfig?: any): boolean { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!path || path === '/') {
      return true
    }

    if (!this.coerceBoolean(geminiConfig?.path_filters_enabled)) {
      return true
    }

    const allowedPrefixes = this.normalizeStringArray(geminiConfig?.path_allowed_prefixes)
    if (allowedPrefixes.length > 0) {
      const isAllowed = allowedPrefixes.some((prefix) => {
        if (prefix === '/') {
          return true
        }
        const normalizedPrefix = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
        return path === normalizedPrefix || path.startsWith(normalizedPrefix + '/')
      })

      if (!isAllowed) {
        return false
      }
    }

    const configuredDeniedPrefixes = this.normalizeStringArray(geminiConfig?.path_denied_prefixes)
    const deniedPrefixes = configuredDeniedPrefixes.length > 0
      ? configuredDeniedPrefixes
      : [
        '/updates',
        '/about',
        '/privacy',
        '/terms',
        '/policies',
        '/intl',
        '/auth',
        '/signin',
        '/login',
      ]

    return !deniedPrefixes.some((prefix) => path === prefix || path.startsWith(prefix + '/'))
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
          void this.processPage().catch((error) => {
            console.error('[LLM Chatbot Browser] Error in mutation observer callback:', error)
          })
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
      setTimeout(() => {
        void this.processPage().catch((error) => {
          console.error('[LLM Chatbot Browser] Error in initial page processing:', error)
        })
      }, 1000)

      console.log('[LLM Chatbot Browser] Event-driven transmission started (mutation-driven promotions with bounded completion self-rechecks)')
    } catch (error) {
      console.error('[LLM Chatbot Browser] Error starting capture:', error)
    }
  }

  private getOrCreateResponseContainerKey(container: Element): string {
    const existing = this.responseContainerKeys.get(container)
    if (existing) {
      return existing
    }

    this.responseContainerKeySequence += 1
    const key = `resp-${this.responseContainerKeySequence}`
    this.responseContainerKeys.set(container, key)
    return key
  }

  /**
   * Generate a key for content matching and update detection.
   * For responses, include a stable response-container scope so similar text across
   * different turns cannot collide in prefix dedupe/update logic.
   */
  private getPrefixKey(content: string, type: string, responseContainer?: Element): string {
    const normalized = content.trim().substring(0, this.PREFIX_LENGTH).replace(/\s+/g, ' ')
    if (type === 'response' && responseContainer) {
      const responseContainerKey = this.getOrCreateResponseContainerKey(responseContainer)
      return `${type}:${responseContainerKey}:${normalized}`
    }

    return `${type}:${normalized}`
  }

  /**
   * Stable per-response guard key that survives container remounts.
   * This prevents a capped pending response from being re-enqueued forever
   * when React replaces DOM nodes and container-scoped prefix keys change.
   */
  private getResponseRetryGuardKey(content: string): string {
    const normalized = content.trim().substring(0, this.PREFIX_LENGTH).replace(/\s+/g, ' ')
    return `response:${normalized}`
  }

  private getCompletionRecheckKey(source: string, turnNumber: number): string {
    return `${source}:response-turn:${turnNumber}`
  }

  private clearCompletionRecheck(key: string): void {
    const timer = this.completionRecheckTimers.get(key)
    if (timer) {
      clearTimeout(timer)
      this.completionRecheckTimers.delete(key)
    }
    this.completionRecheckAttempts.delete(key)
  }

  private clearAllCompletionRechecks(): void {
    for (const timer of this.completionRecheckTimers.values()) {
      clearTimeout(timer)
    }
    this.completionRecheckTimers.clear()
    this.completionRecheckAttempts.clear()
  }

  private scheduleCompletionRecheck(
    key: string,
    reason: string,
    delayMs: number = this.COMPLETION_RECHECK_DELAY_MS,
  ): void {
    if (this.completionRecheckTimers.has(key)) {
      return
    }

    const attempts = this.completionRecheckAttempts.get(key) || 0
    if (attempts >= this.MAX_COMPLETION_RECHECK_ATTEMPTS) {
      return
    }

    const nextAttempt = attempts + 1
    const timer = setTimeout(() => {
      this.completionRecheckTimers.delete(key)
      this.completionRecheckAttempts.set(key, nextAttempt)
      console.log(
        `[LLM Chatbot Browser] Completion recheck attempt ${nextAttempt}/${this.MAX_COMPLETION_RECHECK_ATTEMPTS} (${reason})`,
      )
      void this.processPage().catch((error) => {
        console.error('[LLM Chatbot Browser] Error in completion recheck pass:', error)
      })
    }, Math.max(0, delayMs))

    this.completionRecheckTimers.set(key, timer)
  }

  private hasUrlBackedSources(sources?: (ExtractedSource | ExtractedSourceGroup)[]): boolean {
    if (!sources || sources.length === 0) return false
    return sources.some((s) => {
      if ('sources' in s) return (s as ExtractedSourceGroup).sources.some((e) => !!e.source_url)
      return !!(s as ExtractedSource).source_url
    })
  }

  private countSourceEntries(sources: (ExtractedSource | ExtractedSourceGroup)[]): number {
    return sources.reduce((n, s) => {
      if ('sources' in s) return n + (s as ExtractedSourceGroup).sources.length
      return n + 1
    }, 0)
  }

  private disconnectTurnRetryObserver(pendingEntry?: PendingSourceExtractionInfo): void {
    if (!pendingEntry?.turnRetryObserver) {
      return
    }

    pendingEntry.turnRetryObserver.disconnect()
    pendingEntry.turnRetryObserver = undefined
  }

  private isTurnScopedSourceMutation(node: Node | null | undefined, sourceDetailSelector?: string): boolean {
    if (!node) {
      return false
    }

    const element = node instanceof Element ? node : node.parentElement
    if (!element) {
      return false
    }

    const panelSelectors = [
      sourceDetailSelector,
      'context-sidebar',
      'side-bar-sources',
      '.all-sources',
      '.sources-list',
      'inline-source-card',
    ].filter(Boolean) as string[]

    return panelSelectors.some((selector) => {
      try {
        return element.matches(selector) || element.querySelector(selector) !== null
      } catch {
        return false
      }
    })
  }

  private armTurnScopedRetry(prefixKey: string, pendingEntry: PendingSourceExtractionInfo): void {
    if (pendingEntry.turnRetryObserver) {
      return
    }

    const sourceDetailSelector = this.parser?.selectors?.sourceDetailAnchors
    const observer = new MutationObserver((mutations) => {
      const sawRelevantMutation = mutations.some((mutation) => {
        if (this.isTurnScopedSourceMutation(mutation.target, sourceDetailSelector)) {
          return true
        }

        const changedNodes = Array.from(mutation.addedNodes).concat(Array.from(mutation.removedNodes))
        return changedNodes.some((node) => this.isTurnScopedSourceMutation(node, sourceDetailSelector))
      })

      if (!sawRelevantMutation) {
        return
      }

      const latestPendingEntry = this.pendingSourcesExtraction.get(prefixKey)
      this.disconnectTurnRetryObserver(latestPendingEntry)
      console.log('[LLM Chatbot Browser] Turn-scoped source retry triggered for pending response')
      this.promoteReadyResponses('turn-retry')
    })

    pendingEntry.turnRetryObserver = observer
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    })
    console.log('[LLM Chatbot Browser] Armed turn-scoped source retry for pending response')
  }

  private upgradeQueuedResponseSources(prefixKey: string, extractedSources: (ExtractedSource | ExtractedSourceGroup)[]): boolean {
    if (extractedSources.length === 0) {
      return false
    }

    const currentCapture = this.capturedPrefixes.get(prefixKey)
    const pendingEntry = this.pendingSourcesExtraction.get(prefixKey)
    const queuedInteractionId = currentCapture?.interaction_id || pendingEntry?.interaction.interaction_id

    if (!queuedInteractionId) {
      return false
    }

    const queuedInteraction = this.interactions.find((interaction) => interaction.interaction_id === queuedInteractionId)

    if (!queuedInteraction && pendingEntry?.interaction.interaction_id !== queuedInteractionId) {
      return false
    }

    const targetInteraction = queuedInteraction || pendingEntry?.interaction
    if (!targetInteraction || targetInteraction.type !== 'response') {
      return false
    }

    const currentSources = targetInteraction.sources || []
    const currentHasUrls = this.hasUrlBackedSources(currentSources)
    const nextHasUrls = this.hasUrlBackedSources(extractedSources)

    const nextCount = this.countSourceEntries(extractedSources)
    const currentCount = this.countSourceEntries(currentSources)

    if (!nextHasUrls && nextCount <= currentCount) {
      return false
    }

    if (currentHasUrls && !nextHasUrls) {
      return false
    }

    if (currentHasUrls === nextHasUrls && nextCount <= currentCount) {
      return false
    }

    targetInteraction.sources = extractedSources

    // Keep pending interaction in sync so it can be promoted without re-extracting.
    if (pendingEntry?.interaction) {
      pendingEntry.interaction.sources = extractedSources
    }
    return true
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
        // Newer URLs can be /search/{uuid} or /search/new/{uuid}
        const uuidMatch = searchPath.match(/(?:^|\/)([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i)
        if (uuidMatch) {
          return uuidMatch[1]
        }
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
      this.clearAllCompletionRechecks()
      
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

  private buildCheckpointStorageKey(): string {
    const source = this.parser?.name || 'unknown'
    const url = new URL(window.location.href)
    const pathScope = url.pathname || '/'
    return `${this.CHECKPOINT_KEY_PREFIX}:${source}:${pathScope}`
  }

  private loadCaptureCheckpoint(): Promise<void> {
    return new Promise((resolve) => {
      const key = this.buildCheckpointStorageKey()
      let raw: any
      try {
        const serialized = window.sessionStorage.getItem(key)
        raw = serialized ? JSON.parse(serialized) : undefined
      } catch (error) {
        console.warn('[LLM Chatbot Browser] Failed to parse checkpoint, ignoring:', error)
      }

      if (raw && typeof raw === 'object' && raw.version === 1) {
        const age = Date.now() - (raw.updatedAt || 0)
        if (age < this.CHECKPOINT_TTL_MS) {
          const prefixes: Record<string, number> = raw.prefixes || {}
          for (const [prefixKey, length] of Object.entries(prefixes)) {
            if (typeof length === 'number' && !this.capturedPrefixes.has(prefixKey)) {
              this.capturedPrefixes.set(prefixKey, { interaction_id: 'persisted', length })
            }
          }
          this.captureCheckpointMaxQts = typeof raw.maxQuestionTimestamp === 'number' ? raw.maxQuestionTimestamp : 0
          console.log(`[LLM Chatbot Browser] Restored checkpoint: ${Object.keys(prefixes).length} prefixes, maxQts=${this.captureCheckpointMaxQts} (age ${Math.round(age / 60000)}min)`)
        } else {
          console.log(`[LLM Chatbot Browser] Checkpoint expired (age ${Math.round((Date.now() - (raw.updatedAt || 0)) / 60000)}min), starting fresh`)
        }
      }

      this.captureCheckpointLoaded = true
      resolve()
    })
  }

  private schedulePersistCheckpoint(): void {
    if (this.checkpointPersistTimer) clearTimeout(this.checkpointPersistTimer)
    this.checkpointPersistTimer = setTimeout(() => this.persistCaptureCheckpoint(), this.DEBOUNCE_MS)
  }

  private persistCaptureCheckpoint(): void {
    if (!this.captureCheckpointLoaded) return
    const prefixes: Record<string, number> = {}
    const entries = Array.from(this.capturedPrefixes.entries())
    const bounded = entries.slice(-this.CHECKPOINT_MAX_KEYS)
    for (const [k, v] of bounded) {
      // Strip session-scoped question suffixes so the key is stable across reloads.
      // Same-session keys like :qts-{ts}, :qid-{id}, :turn-{n} are regenerated each
      // page load; storing the content-based base key lets the reload checkpoint match.
      const persistKey = k.replace(/:qts-\d+$|:qid-[^:]+$|:turn-\d+$/, '')
      prefixes[persistKey] = v.length
    }
    const key = this.buildCheckpointStorageKey()
    const payload = {
      version: 1,
      updatedAt: Date.now(),
      maxQuestionTimestamp: this.captureCheckpointMaxQts,
      prefixes,
    }
    try {
      window.sessionStorage.setItem(key, JSON.stringify(payload))
    } catch (error) {
      console.warn('[LLM Chatbot Browser] Failed to persist checkpoint:', error)
    }
    console.log(`[LLM Chatbot Browser] Checkpoint persisted: ${bounded.length} prefixes`)
  }

  private isPerplexityTerminalSourceResult(result: unknown): result is SourceExtractionResult {
    return !!result &&
      typeof result === 'object' &&
      Array.isArray((result as SourceExtractionResult).sources) &&
      typeof (result as SourceExtractionResult).source_extraction === 'string'
  }

  private createPerplexityPanelLifecycleObserver(
    sourceCloseSelector: string | undefined,
    panelContainerSelector: string,
    sourceDetailSelector: string | undefined,
  ): { stop: (label: string) => void } {
    if (!sourceCloseSelector) {
      return {
        stop: () => undefined,
      }
    }

    const startedAt = Date.now()
    let openTransitions = 0
    let closeTransitions = 0
    let lastCloseButtonsVisible = document.querySelectorAll(sourceCloseSelector).length > 0

    const observer = new MutationObserver(() => {
      const closeButtonsVisibleNow = document.querySelectorAll(sourceCloseSelector).length > 0
      if (closeButtonsVisibleNow === lastCloseButtonsVisible) {
        return
      }

      if (closeButtonsVisibleNow) {
        openTransitions += 1
      } else {
        closeTransitions += 1
      }

      console.log(
        `[LLM Chatbot Browser] Perplexity panel MO transition: ` +
        `${lastCloseButtonsVisible ? 'open->closed' : 'closed->open'} ` +
        `(open_transitions=${openTransitions}, close_transitions=${closeTransitions})`,
      )

      lastCloseButtonsVisible = closeButtonsVisibleNow
    })

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    })

    return {
      stop: (label: string) => {
        observer.disconnect()
        const elapsedMs = Date.now() - startedAt
        const closeButtonsVisible = document.querySelectorAll(sourceCloseSelector).length
        const openPanelCandidates = document.querySelectorAll(panelContainerSelector).length
        const detailAnchorsVisible = sourceDetailSelector
          ? document.querySelectorAll(sourceDetailSelector).length
          : 0

        console.log(
          `[LLM Chatbot Browser] Perplexity panel MO summary (${label}): ` +
          `open_transitions=${openTransitions} ` +
          `close_transitions=${closeTransitions} ` +
          `elapsed_ms=${elapsedMs} ` +
          `close_buttons=${closeButtonsVisible} ` +
          `open_panels=${openPanelCandidates} ` +
          `detail_anchors=${detailAnchorsVisible}`,
        )
      },
    }
  }

  private async processPage(): Promise<void> {
    if (this.processInFlight) {
      this.processQueued = true
      return
    }

    this.processInFlight = true

    if (!this.captureCheckpointLoaded) {
      console.debug('[LLM Chatbot Browser] Checkpoint not yet loaded, deferring page processing')
      this.processInFlight = false
      return
    }
    if (!this.parser) {
      console.debug('[LLM Chatbot Browser] No parser available, skipping page processing')
      this.processInFlight = false
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
        if (this.emptyDomSinceMs === null) {
          this.emptyDomSinceMs = Date.now()
          console.log('[LLM Chatbot Browser] DOM empty snapshot detected; waiting before conversation reset')
        }

        const emptyDurationMs = Date.now() - this.emptyDomSinceMs
        if (emptyDurationMs < this.EMPTY_DOM_RESET_GRACE_MS) {
          // SPA remounts can briefly drop all nodes; avoid clearing dedupe/checkpoint state too early.
          return
        }

        console.log('[LLM Chatbot Browser] Messages absent beyond grace period - new conversation detected')
        // Reset for confirmed new conversation
        this.localSessionId = undefined
        this.capturedPrefixes.clear()
        this.clearAllCompletionRechecks()
        this.captureCheckpointMaxQts = 0
        this.captureCheckpointLoaded = true
        window.sessionStorage.removeItem(this.buildCheckpointStorageKey())
        this.currentConversationId = undefined
        this.lastCheckedUrl = ''  // Force URL re-check
        this.emptyDomSinceMs = null
      } else if (hasMessagesNow) {
        this.emptyDomSinceMs = null
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
      const interactionOrdinalByType = new Map<'question' | 'response', number>()
      for (const interaction of newInteractions) {
        const nextTurnNumber = (interactionOrdinalByType.get(interaction.type) || 0) + 1
        interactionOrdinalByType.set(interaction.type, nextTurnNumber)

        const responseContainerRef: Element | undefined =
          interaction.type === 'response' && typeof this.parser.resolveContainer === 'function'
            ? this.parser.resolveContainer(interaction.content)
            : undefined

        // Parser-owned completion decisions gate response capture.
        if (
          interaction.type === 'response' &&
          this.parser?.name === 'chatgpt' &&
          typeof this.parser.getCompletionDecision === 'function'
        ) {
          const completionDecision = this.parser.getCompletionDecision(interaction.content) as ChatGPTCompletionDecision
          const completionRecheckKey = this.getCompletionRecheckKey(this.parser.name, nextTurnNumber)
          const completionAttempts = this.completionRecheckAttempts.get(completionRecheckKey) || 0
          const canForcePromotionAfterRetries = completionDecision.reason === 'stability_pending'

          if (!completionDecision.completed) {
            if (
              completionDecision.shouldRecheck &&
              canForcePromotionAfterRetries &&
              completionAttempts < this.MAX_COMPLETION_RECHECK_ATTEMPTS
            ) {
              this.scheduleCompletionRecheck(
                completionRecheckKey,
                completionDecision.reason,
                completionDecision.recheckDelayMs ?? this.COMPLETION_RECHECK_DELAY_MS,
              )
              continue
            }

            if (
              completionDecision.shouldRecheck &&
              canForcePromotionAfterRetries &&
              completionAttempts >= this.MAX_COMPLETION_RECHECK_ATTEMPTS
            ) {
              console.warn(
                `[LLM Chatbot Browser] Completion unresolved after ${this.MAX_COMPLETION_RECHECK_ATTEMPTS} attempts; promoting latest response snapshot (${completionDecision.reason})`,
              )
              this.clearCompletionRecheck(completionRecheckKey)
            } else {
              if (!canForcePromotionAfterRetries) {
                this.clearCompletionRecheck(completionRecheckKey)
              }
              continue
            }
          } else {
            this.clearCompletionRecheck(completionRecheckKey)
          }
        } else if (
          interaction.type === 'response' &&
          typeof this.parser.isResponseComplete === 'function' &&
          !this.parser.isResponseComplete(interaction.content)
        ) {
          continue
        }

        // Generate a scoped key for this content.
        const basePrefixKey = this.getPrefixKey(interaction.content, interaction.type, responseContainerRef)
        let prefixKey = basePrefixKey
        const parserQuestionTimestamp = (interaction as { question_timestamp?: number }).question_timestamp
        const parserQuestionTurnId = (interaction as { turn_id?: string }).turn_id
        if (interaction.type === 'question') {
          // Prefer parser-provided stable question timestamp (question + timestamp keying).
          // Fall back to legacy turn_id and finally per-snapshot turn number.
          prefixKey = typeof parserQuestionTimestamp === 'number'
            ? `${basePrefixKey}:qts-${parserQuestionTimestamp}`
            : parserQuestionTurnId
              ? `${basePrefixKey}:qid-${parserQuestionTurnId}`
              : `${basePrefixKey}:turn-${nextTurnNumber}`
        }
        const responseTurnFallbackKey = interaction.type === 'response'
          ? `response-turn:${nextTurnNumber}:${interaction.content.trim().substring(0, this.PREFIX_LENGTH).replace(/\s+/g, ' ')}`
          : undefined
        const currentLength = interaction.content.length
        // For questions the prefixKey carries a session-scoped suffix (:qts-/qid-/turn-).
        // After a reload the suffix differs, so also check the stable base key which is
        // what the checkpoint restores. Responses use basePrefixKey directly; no change needed.
        const existingCapture = this.capturedPrefixes.get(prefixKey)
          ?? (interaction.type === 'question' ? this.capturedPrefixes.get(basePrefixKey) : undefined)
          ?? (interaction.type === 'response' && responseTurnFallbackKey ? this.capturedPrefixes.get(responseTurnFallbackKey) : undefined)

        // Extract sources immediately if this is a response (don't wait until transmission)
        let extractedSources: (ExtractedSource | ExtractedSourceGroup)[] = []
        let sourceExtractionState: LLMInteraction['source_extraction'] | undefined = undefined
        if (
          interaction.type === 'response' &&
          typeof this.parser.extractSources === 'function' &&
          (!existingCapture || currentLength > existingCapture.length)
        ) {
          try {
            const sourceToggleSelector = this.parser?.selectors?.sourceToggleButton
            const isPerplexityParser = this.parser?.name === 'perplexity'

            // Non-panel parsers should extract immediately.
            // Panel-based parsers should still attempt extraction immediately so
            // turn-complete empty-source states can be finalized without waiting
            // on a separate toggle-visibility pass.
            if (isPerplexityParser) {
              const sourceToggleSelector = this.parser?.selectors?.sourceToggleButton
              const sourceDetailSelector = this.parser?.selectors?.sourceDetailAnchors
              const sourceCloseSelector = this.parser?.selectors?.sourceCloseButton
              const panelContainerSelector = 'side-bar-sources, context-sidebar, .all-sources, .sources-list'
              const panelLifecycleObserver = this.createPerplexityPanelLifecycleObserver(
                sourceCloseSelector,
                panelContainerSelector,
                sourceDetailSelector,
              )

              const toggleInTurn = sourceToggleSelector && responseContainerRef
                ? responseContainerRef.querySelector(sourceToggleSelector)
                : null
              const openPanelCandidates = document.querySelectorAll(panelContainerSelector).length
              const detailAnchorsVisible = sourceDetailSelector
                ? document.querySelectorAll(sourceDetailSelector).length
                : 0
              const closeButtonsVisible = sourceCloseSelector
                ? document.querySelectorAll(sourceCloseSelector).length
                : 0
              const panelPresentBySignals = closeButtonsVisible > 0

              console.log(
                `[LLM Chatbot Browser] Perplexity pre-extract panel state: ` +
                `toggle_in_turn=${toggleInTurn ? 'yes' : 'no'} ` +
                `open_panels=${openPanelCandidates} ` +
                `detail_anchors=${detailAnchorsVisible} ` +
                `close_buttons=${closeButtonsVisible} ` +
                `panel_present=${panelPresentBySignals ? 'yes' : 'no'}`,
              )

              try {
                const extractionResult = await this.parser.extractSources(responseContainerRef ?? interaction.content)
                if (this.isPerplexityTerminalSourceResult(extractionResult)) {
                  extractedSources = extractionResult.sources
                  sourceExtractionState = extractionResult.source_extraction

                  const shouldAttemptClose = !!extractionResult.close_panel
                  if (shouldAttemptClose && typeof this.parser.abortSourceExtraction === 'function') {
                    this.parser.abortSourceExtraction(responseContainerRef ?? interaction.content)

                    const postClosePanelCandidates = document.querySelectorAll(panelContainerSelector).length
                    const postCloseDetailAnchors = sourceDetailSelector
                      ? document.querySelectorAll(sourceDetailSelector).length
                      : 0
                    const postCloseButtonsVisible = sourceCloseSelector
                      ? document.querySelectorAll(sourceCloseSelector).length
                      : 0
                    const postClosePanelPresent = postCloseButtonsVisible > 0

                    console.log(
                      `[LLM Chatbot Browser] Perplexity post-close attempt: ` +
                      `open_panels=${postClosePanelCandidates} ` +
                      `detail_anchors=${postCloseDetailAnchors} ` +
                      `close_buttons=${postCloseButtonsVisible} ` +
                      `panel_present=${postClosePanelPresent ? 'yes' : 'no'}`,
                    )
                  }

                  console.log(
                    `[LLM Chatbot Browser] Perplexity terminal source result: ${sourceExtractionState} (${extractedSources.length} groups)`,
                  )
                } else if (Array.isArray(extractionResult)) {
                  extractedSources = extractionResult
                  sourceExtractionState = extractedSources.length > 0 ? 'success' : 'terminal_empty'
                } else {
                  sourceExtractionState = 'data_capture_error'
                }
              } finally {
                panelLifecycleObserver.stop('extract-cycle')
              }
            } else if (!sourceToggleSelector) {
              extractedSources = this.parser.extractSources(interaction.content)
              if (this.parser?.name === 'chatgpt') {
                sourceExtractionState = 'success'
              } else if (this.parser?.name === 'gemini' && typeof this.parser.getSourceExtractionStatus === 'function') {
                sourceExtractionState =
                  this.parser.getSourceExtractionStatus(responseContainerRef ?? interaction.content) ||
                  (extractedSources.length > 0 ? 'success' : 'none')
              }
              if (extractedSources.length > 0) {
                console.log(`[LLM Chatbot Browser] Extracted ${extractedSources.length} sources immediately for response`)
                // Close the sources panel after extraction completes
                if (typeof this.parser.closeSourcesPanel === 'function') {
                  this.parser.closeSourcesPanel()
                }
              }
            } else {
              const sourcesButton = responseContainerRef?.querySelector(sourceToggleSelector) || null
              extractedSources = this.parser.extractSources(responseContainerRef ?? interaction.content)
              if (this.parser?.name === 'chatgpt') {
                sourceExtractionState = 'success'
              } else if (this.parser?.name === 'gemini' && typeof this.parser.getSourceExtractionStatus === 'function') {
                sourceExtractionState =
                  this.parser.getSourceExtractionStatus(responseContainerRef ?? interaction.content) ||
                  (extractedSources.length > 0 ? 'success' : 'none')
              }
              if (sourcesButton) {
                if (extractedSources.length > 0) {
                  console.log(`[LLM Chatbot Browser] Extracted ${extractedSources.length} sources immediately for response (sources button detected in DOM)`)
                  if (typeof this.parser.closeSourcesPanel === 'function') {
                    this.parser.closeSourcesPanel()
                  }
                }
              } else {
                console.log(`[LLM Chatbot Browser] Response detected without visible source toggle in turn container; extraction still attempted`)
              }
            }
          } catch (error) {
            console.error('[LLM Chatbot Browser] Error extracting sources immediately:', error)
            if (this.parser?.name === 'chatgpt') {
              sourceExtractionState = 'failed'
            } else if (this.parser?.name === 'gemini') {
              sourceExtractionState = 'data_capture_error'
            }
          }
        }

        if (existingCapture) {
          if (interaction.type === 'response' && extractedSources.length > 0) {
            const upgraded = this.upgradeQueuedResponseSources(prefixKey, extractedSources)
            if (upgraded) {
              console.log(
                `[LLM Chatbot Browser] Upgraded queued response sources to ${extractedSources.length} entries`,
              )

              // If this response is pending, promote it now to avoid infinite pending retries.
              const pending = this.pendingSourcesExtraction.get(prefixKey)
              if (pending) {
                this.disconnectTurnRetryObserver(pending)
                this.interactions.push(pending.interaction)
                this.pendingSourcesExtraction.delete(prefixKey)
                console.log('[LLM Chatbot Browser] Promoted pending response immediately after source upgrade')
              }
            }
          }

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
            question_timestamp: interaction.type === 'question' && typeof parserQuestionTimestamp === 'number' ? parserQuestionTimestamp : undefined,
            length: currentLength,
            url: window.location.href,
            conversation_id: this.getEffectiveConversationId(),
            turn_number: nextTurnNumber,
            sources: interaction.type === 'response' ? extractedSources : [],
            source_extraction: interaction.type === 'response' ? sourceExtractionState : undefined,
          }
          if (newInteraction.type === 'response') {
            pageCaptureModule.setCorrelationId(newId)
          }
          if (newInteraction.type === 'response') {
            console.log(`[LLM Chatbot Browser] Response update created with ${newInteraction.sources?.length || 0} sources`)
          }

          // Update the map with new ID and length
          this.capturedPrefixes.set(prefixKey, { interaction_id: newId, length: currentLength })
          if (responseTurnFallbackKey) {
            this.capturedPrefixes.set(responseTurnFallbackKey, { interaction_id: newId, length: currentLength })
          }
          if (typeof parserQuestionTimestamp === 'number' && parserQuestionTimestamp > this.captureCheckpointMaxQts) {
            this.captureCheckpointMaxQts = parserQuestionTimestamp
          }
          this.schedulePersistCheckpoint()
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
            question_timestamp: interaction.type === 'question' && typeof parserQuestionTimestamp === 'number' ? parserQuestionTimestamp : undefined,
            length: currentLength,
            url: window.location.href,
            conversation_id: this.getEffectiveConversationId(),
            turn_number: nextTurnNumber,
            sources: interaction.type === 'response' ? extractedSources : [],
            source_extraction: interaction.type === 'response' ? sourceExtractionState : undefined,
          }
          if (newInteraction.type === 'response') {
            pageCaptureModule.setCorrelationId(newId)
          }
          if (newInteraction.type === 'response') {
            console.log(`[LLM Chatbot Browser] Response created with ${newInteraction.sources?.length || 0} sources`)
          }

          this.capturedPrefixes.set(prefixKey, { interaction_id: newId, length: currentLength })
          if (responseTurnFallbackKey) {
            this.capturedPrefixes.set(responseTurnFallbackKey, { interaction_id: newId, length: currentLength })
          }
          if (typeof parserQuestionTimestamp === 'number' && parserQuestionTimestamp > this.captureCheckpointMaxQts) {
            this.captureCheckpointMaxQts = parserQuestionTimestamp
          }
          this.schedulePersistCheckpoint()

          // For responses without sources extracted, hold only for panel-based parsers when
          // parser has not yet finalized source extraction for this specific turn.
          const hasPanelSourceToggle = !!this.parser?.selectors?.sourceToggleButton
          const containerRef: Element | undefined = responseContainerRef
          const sourceExtractionComplete =
            newInteraction.type === 'response' &&
            typeof this.parser?.isSourceExtractionComplete === 'function'
              ? this.parser.isSourceExtractionComplete(containerRef ?? newInteraction.content)
              : false

          if (
            newInteraction.type === 'response' &&
            this.parser?.name !== 'perplexity' &&
            hasPanelSourceToggle &&
            (!newInteraction.sources || newInteraction.sources.length === 0) &&
            !sourceExtractionComplete
          ) {
            const retryGuardKey = this.getResponseRetryGuardKey(newInteraction.content)
            if (this.sourceRetryExhaustedKeys.has(retryGuardKey)) {
              console.warn('[LLM Chatbot Browser] Source retries previously exhausted for this response content; bypassing pending queue')
              this.interactions.push(newInteraction)
              if (this.interactions.length >= this.batchSize) {
                console.log(`[LLM Chatbot Browser] Batch full (${this.interactions.length}), triggering transmission`)
                this.transmitBatch()
              }
              newCaptureCount++
              console.log(
                `[LLM Chatbot Browser] Captured ${interaction.type}: ${interaction.content.substring(0, 50)}...`,
              )
              continue
            }

            console.log(`[LLM Chatbot Browser] Response deferred to pending queue (turn-scoped source retry enabled)`)
            // Store the container element now so deferred extraction remains pinned to this turn.
            const existingPending = this.pendingSourcesExtraction.get(prefixKey)
            this.disconnectTurnRetryObserver(existingPending)
            this.pendingSourcesExtraction.set(prefixKey, {
              interaction: newInteraction,
              containerRef,
              unresolvedRetryCount: 0,
            })
            // Trigger the first extraction pass immediately for this turn.
            this.promoteReadyResponses('initial')
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

      // Mutation-driven pending promotion: re-evaluate pending entries whenever DOM changes.
      this.promoteReadyResponses('general')

      // Event-driven flush: when nothing is pending, transmit queued interactions now.
      if (this.pendingSourcesExtraction.size === 0 && this.interactions.length > 0) {
        this.transmitBatch()
      }

      console.debug(`[LLM Chatbot Browser] Pending for transmission: ${this.interactions.length}`)
    } catch (error) {
      console.error('[LLM Chatbot Browser] Error processing page:', error)
    } finally {
      this.processInFlight = false
      if (this.processQueued) {
        this.processQueued = false
        setTimeout(() => {
          void this.processPage().catch((error) => {
            console.error('[LLM Chatbot Browser] Error in queued page processing:', error)
          })
        }, 0)
      }
    }
  }

  /**
   * Check pending responses and promote when sources are ready to extract.
   * Sources button appears after response is fully rendered, so checking for
    * Extraction is turn-scoped and mutation-driven until parser marks the turn complete.
   * Also collects MutationObserver panel lifecycle validation.
   */
  private promoteReadyResponses(trigger: 'general' | 'initial' | 'turn-retry' = 'general'): void {
    const toRemove: string[] = []
    let promotedCount = 0

    // Perplexity now resolves extraction terminally in processPage.
    // If any stale pending entries remain from a prior runtime state, flush them safely.
    if (this.parser?.name === 'perplexity') {
      for (const [prefixKey, pending] of this.pendingSourcesExtraction.entries()) {
        this.disconnectTurnRetryObserver(pending)
        pending.interaction.source_extraction = pending.interaction.source_extraction || 'data_capture_error'
        this.interactions.push(pending.interaction)
        toRemove.push(prefixKey)
        promotedCount += 1
      }

      for (const key of toRemove) {
        const pendingEntry = this.pendingSourcesExtraction.get(key)
        this.disconnectTurnRetryObserver(pendingEntry)
        this.pendingSourcesExtraction.delete(key)
      }

      if (promotedCount > 0) {
        console.log(`[LLM Chatbot Browser] Flushed ${promotedCount} stale pending Perplexity entries after terminal extraction migration`)
      }
      return
    }

    for (const [prefixKey, pending] of this.pendingSourcesExtraction.entries()) {
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

      const sourcesButtonVisible = pending.containerRef
        ? pending.containerRef.querySelector(sourcesButtonSelector) !== null
        : !!document.querySelector(sourcesButtonSelector)

      if (!sourcesButtonVisible) {
        console.log('[LLM Chatbot Browser] Source toggle not visible for pending turn; attempting extraction anyway')
      }

      // Attempt extraction for this pending turn regardless of toggle visibility;
      // parser-level logic decides whether this turn is complete or should remain pending.
      if (this.parser && typeof this.parser.extractSources === 'function') {
        try {
          // Use stored container reference when available to avoid stale content matching
          // when newer responses have appeared since this turn was enqueued.
          const updatedSources = this.parser.extractSources(pending.containerRef ?? pending.interaction.content)
          if (updatedSources && updatedSources.length > 0) {
            pending.unresolvedRetryCount = 0
            pending.interaction.sources = updatedSources
            if (this.parser?.name === 'gemini') {
              pending.interaction.source_extraction = 'success'
            }
            console.log(
              `[LLM Chatbot Browser] Extracted ${updatedSources.length} sources`,
            )
          } else {
            if (typeof this.parser?.isSourceExtractionComplete === 'function') {
              const complete = this.parser.isSourceExtractionComplete(pending.containerRef ?? pending.interaction.content)
              if (complete) {
                if (this.parser?.name === 'gemini' && typeof this.parser.getSourceExtractionStatus === 'function') {
                  pending.interaction.source_extraction =
                    this.parser.getSourceExtractionStatus(pending.containerRef ?? pending.interaction.content) ||
                    'none'
                }
                this.disconnectTurnRetryObserver(pending)
                this.interactions.push(pending.interaction)
                promotedCount++
                toRemove.push(prefixKey)
                console.log('[LLM Chatbot Browser] Promoted response after extraction completed')
                continue
              }
            }
            const shouldCountRetry = trigger === 'initial' || trigger === 'turn-retry'
            if (shouldCountRetry) {
              pending.unresolvedRetryCount += 1
            }
            if (pending.unresolvedRetryCount >= this.MAX_PENDING_SOURCE_RETRIES) {
              console.warn(
                `[LLM Chatbot Browser] Source extraction unresolved after ${pending.unresolvedRetryCount} retries; promoting response with current sources`,
              )
              if (this.parser?.name === 'gemini') {
                pending.interaction.source_extraction = sourcesButtonVisible ? 'terminal_empty' : 'panel_opening_failure'
              }
              this.sourceRetryExhaustedKeys.add(this.getResponseRetryGuardKey(pending.interaction.content))
              this.disconnectTurnRetryObserver(pending)
              if (typeof this.parser?.abortSourceExtraction === 'function') {
                this.parser.abortSourceExtraction(pending.containerRef ?? pending.interaction.content)
              }
              this.interactions.push(pending.interaction)
              promotedCount++
              toRemove.push(prefixKey)
              continue
            }
            // Sources are still unresolved for this turn. Arm a turn-scoped retry that
            // re-attempts extraction only when source-detail DOM mutates for this response.
            if (shouldCountRetry) {
              console.log(
                `[LLM Chatbot Browser] Pending source extraction retry ${pending.unresolvedRetryCount}/${this.MAX_PENDING_SOURCE_RETRIES} for this turn`,
              )
            } else {
              console.log('[LLM Chatbot Browser] Pending source extraction unresolved (general mutation pass; retry counter unchanged)')
            }
            this.armTurnScopedRetry(prefixKey, pending)
            continue
          }
        } catch (error) {
          console.error(`[LLM Chatbot Browser] Error extracting sources:`, error)
          this.disconnectTurnRetryObserver(pending)
          if (typeof this.parser?.abortSourceExtraction === 'function') {
            this.parser.abortSourceExtraction(pending.containerRef ?? pending.interaction.content)
          }
          this.interactions.push(pending.interaction)
          promotedCount++
          toRemove.push(prefixKey)
          continue
        }
      }

      if (!pending.interaction.sources || pending.interaction.sources.length === 0) {
        continue
      }

      // Promote to transmission queue (sources may be empty or populated, both okay)
      this.disconnectTurnRetryObserver(pending)
      this.interactions.push(pending.interaction)
      promotedCount++
      toRemove.push(prefixKey)
      console.log(
        `[LLM Chatbot Browser] Promoted response to transmission (${pending.interaction.sources?.length || 0} sources, panel cycle: unverified)`,
      )
      
      // Check if batch full after promotion
      if (this.interactions.length >= this.batchSize) {
        console.log(`[LLM Chatbot Browser] Batch full after promotion, triggering transmission`)
        this.transmitBatch()
      }
    }

    // Clean up promoted responses
    for (const key of toRemove) {
      const pendingEntry = this.pendingSourcesExtraction.get(key)
      this.disconnectTurnRetryObserver(pendingEntry)
      this.pendingSourcesExtraction.delete(key)
    }
    
    if (promotedCount > 0) {
      console.log(`[LLM Chatbot Browser] Promoted ${promotedCount} responses (sources button detected)`)
    }
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

      // ChatGPT transmission is gated by parser completion (copy-button/full-render signal).
      // This keeps queued question/response data local until the turn reaches a complete state.
      if (
        this.parser?.name === 'chatgpt' &&
        typeof this.parser.getCompletionDecision === 'function'
      ) {
        const decision = this.parser.getCompletionDecision() as ChatGPTCompletionDecision
        if (!decision.completed) {
          console.log(
            `[LLM Chatbot Browser] Holding transmission until ChatGPT completion signal is observed (${decision.reason})`,
          )
          return
        }
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

      for (const interaction of batch) {
        const preview = interaction.content.replace(/\s+/g, ' ').trim().substring(0, 80)
        console.log(
          `[LLM Chatbot Browser] Batch item ${interaction.interaction_id} type=${interaction.type} turn=${interaction.turn_number || 'n/a'} len=${interaction.length} updates=${interaction.updates_interaction_id || 'none'} content="${preview}..."`,
        )
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

// Initialize page HTML capture module for periodic snapshots
void pageCaptureModule.setup().then(() => {
  pageCaptureModule.installListeners()
  console.log('[Browser] Page HTML capture module initialized')
}).catch((error) => {
  console.warn('[Browser] Failed to initialize page HTML capture module:', error)
})

export default llmChatbotModule
