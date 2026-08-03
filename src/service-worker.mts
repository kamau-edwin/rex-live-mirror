import { REXServiceWorkerModule, registerREXModule, dispatchEvent } from '@bric/rex-core/service-worker'
import { pageHtmlCaptureModule as pageCaptureSWModule } from './page-html-capture/service-worker.mjs'

/**
 * LLM Chatbot Module - Service Worker Context
 * Responsible for: receiving multi-platform LLM interaction batches, deduplicating Q/A pairs,
 * and dispatching normalized chatbot events for downstream transmission.
 */
class LLMChatbotServiceWorkerModule extends REXServiceWorkerModule {
  private enabled: boolean = false
  private config: any = null
  private chatGPTCaptureManager: ChatGPTCaptureManager | null = null
  private transmittedHashes: Set<string> = new Set() // Track transmitted interactions to prevent duplicates
  private transmittedQaHashes: Set<string> = new Set() // Track emitted Q&A pairs across uploads/restarts
  private transmittedQaHashesWithSources: Set<string> = new Set() // Track which Q&A hashes were transmitted with sources
  private readonly QA_HASH_STORAGE_KEY: string = 'llm_transmitted_qa_hashes'
  private readonly QA_HASH_MAX_SIZE: number = 1000
  private pendingQuestionByConversation: Map<string, any> = new Map()
  private questionTimestamps: Map<string, number> = new Map() // Track when questions were added (for cleanup)
  private pendingResponsesByConversation: Map<string, any[]> = new Map() // Track responses received before their questions
  private readonly ORPHANED_QUESTION_TIMEOUT_MS: number = 5 * 60 * 1000 // 5 minutes
  private readonly EARLY_RESPONSE_TIMEOUT_MS: number = 30 * 1000 // 30 seconds (wait for question to arrive)
  private cleanupIntervalId: NodeJS.Timeout | null = null
  // Per-conversation question turn counter (1 = first turn, 2 = second, ...),
  // used for chatbot-question's secondary_identifier. Unlike
  // pendingQuestionByConversation this persists for the whole conversation,
  // not just until the next response, so it needs its own idle-based
  // eviction rather than being cleared on answer/orphan like that map is.
  private conversationTurnCounts: Map<string, number> = new Map()
  private conversationTurnLastSeenAt: Map<string, number> = new Map()
  private readonly CONVERSATION_TURN_IDLE_TIMEOUT_MS: number = 30 * 60 * 1000 // 30 minutes
  // A conversation's first question is dispatched before the platform has
  // assigned/exposed a real conversation_id in the URL (browser.mts reads
  // getEffectiveConversationId() synchronously at submit time, before the
  // question has been answered) -- so it arrives here with conversation_id
  // undefined, correctly starting at turn 1 under the "no id" branch below.
  // The *second* question in that same conversation, submitted after the
  // first response rendered, now carries a real id -- but that id has never
  // been seen by conversationTurnCounts, so it would also start at turn 1,
  // silently breaking turn numbering for every conversation past the first
  // question. This tracks the most recently active conversation key per
  // platform so an incoming real id can continue that anonymous counter
  // instead of starting a new one, bounded by the same idle window used for
  // eviction so unrelated conversations across a stale/reopened tab don't
  // get merged.
  private lastActiveConversationKeyByPlatform: Map<string, string> = new Map()

  constructor() {
    super()
  }

  moduleName(): string {
    return 'LLMChatbotServiceWorkerModule'
  }

  setup(): void {
    console.log('[LLM Chatbot] Service Worker module initializing...')

    // Get configuration
    chrome.storage.local.get('REXConfiguration', (result) => {
      if (result.REXConfiguration) {
        const config = result.REXConfiguration
        const llmConfig = config['llm_capture']

        if (llmConfig?.enabled) {
          this.enabled = true
          this.config = llmConfig
          console.log('[LLM Chatbot] Service Worker module enabled')
          console.log('[LLM Chatbot] LLM Capture Config:', llmConfig)

          // Load previously emitted Q&A hashes so dedupe survives service worker restarts.
          chrome.storage.local.get(this.QA_HASH_STORAGE_KEY, (storageResult) => {
            const persisted = storageResult[this.QA_HASH_STORAGE_KEY]
            if (Array.isArray(persisted)) {
              this.transmittedQaHashes = new Set(
                persisted
                  .filter((value) => typeof value === 'string')
                  .slice(-this.QA_HASH_MAX_SIZE)
              )
              console.log(`[LLM Chatbot] Restored ${this.transmittedQaHashes.size} Q&A hashes from storage`)
            }
          })

          // Initialize ChatGPT capture manager
          if (llmConfig.platforms?.chatgpt?.enabled) {
            this.chatGPTCaptureManager = new ChatGPTCaptureManager(
              llmConfig.platforms.chatgpt
            )
            console.log('[LLM Chatbot] ChatGPT capture manager initialized')
          }

          // Start orphaned question cleanup interval (every 30 seconds)
          this.cleanupIntervalId = setInterval(() => {
            this.cleanupOrphanedQuestions()
            this.cleanupStaleConversationTurnCounts()
          }, 30 * 1000)
          console.log('[LLM Chatbot] Orphaned question cleanup interval started')
        }
      }
    })
    // Use message-based transmission only to avoid double-processing from mixed storage/message flows.
  }

  handleMessage(message:any, sender:any, sendResponse:(response:any) => void):boolean { // eslint-disable-line @typescript-eslint/no-explicit-any
    console.log('[LLM Chatbot] Message received:', message.messageType)

    if (message.messageType === 'llmInteractionsBatch') {
      console.log(`[LLM Chatbot] Processing interaction batch of ${message.interactions.length} items`)
      this.handleInteractionBatch(message.interactions)
      sendResponse({ success: true })

      return true
    } else if (message.messageType === 'llmChatGPTCaptureRequest') {
      console.log('[LLM Chatbot] ChatGPT capture request received')
      if (this.chatGPTCaptureManager) {
        this.chatGPTCaptureManager.captureAndQueueData(message.data)
          .then(() => sendResponse({ success: true }))
          .catch((error) => {
            console.error('[LLM Chatbot] Error capturing ChatGPT data:', error)
            sendResponse({ success: false, error: error.message })
          })
        return true  // Async response
      }
    } else if (message.messageType === 'syncHistoricalChats') {
      console.log('[LLM Chatbot] User requested historical chat sync')
      if (this.chatGPTCaptureManager) {
        this.chatGPTCaptureManager.syncHistoricalChatsInBackground()
          .then(() => {
            console.log('[LLM Chatbot] Historical sync completed')
            sendResponse({ success: true, message: 'Historical chats synced successfully' })
          })
          .catch((error) => {
            console.error('[LLM Chatbot] Error syncing historical chats:', error)
            sendResponse({ success: false, error: error.message })
          })
        return true  // Async response
      }
    } else if (message.messageType === 'llmQuestionSubmitted') {
      this.handleQuestionSubmitted(message.question)
      sendResponse({ success: true })
      return true
    }
    return false
  }

  /**
   * Dispatch a standalone PDK event for a question the instant it is submitted,
   * independent of whether a response ever arrives or completes. This is
   * separate from the paired chatbot-interaction event dispatched later in
   * handleInteractionBatch, which still carries the response content/sources.
   */
  private handleQuestionSubmitted(question: any): void { // eslint-disable-line @typescript-eslint/no-explicit-any
    // No this.enabled gate here: this.enabled is set asynchronously inside
    // setup()'s chrome.storage.local.get callback, with no ordering
    // guarantee against the very first llmQuestionSubmitted message -- a
    // freshly woken service worker can receive this message before that
    // callback has resolved. Every other handler in this file has the same
    // shape (no enabled check), so this stays consistent rather than
    // silently dropping a legitimate first question on a race.
    if (!question || typeof question.content !== 'string' || question.content.trim().length === 0) {
      return
    }

    const chatbotName = question.source ?? 'unknown'
    const turnNumber = this.nextConversationTurnNumber(chatbotName, question.conversation_id)

    dispatchEvent({
      name: `chatbot-question-${chatbotName}`,
      event_name: 'chatbot-question',
      generatorId: `chatbot-question-${chatbotName}`,
      chatbot_name: chatbotName,
      secondary_identifier: String(turnNumber),
      turn_number: turnNumber,
      is_first_turn: turnNumber === 1,
      question: {
        url: question.url ?? null,
        conversation_id: question.conversation_id ?? null,
        submitted_at_ms: question.submitted_at_ms ?? null,
        content: question.content,
        length: question.length ?? question.content.length,
      },
    })

    console.log('[LLM Chatbot] Dispatched chatbot-question-' + chatbotName, '(conversation:', question.conversation_id, ', turn:', turnNumber, ')')
  }

  /**
   * Generate a hash for interaction deduplication
   * Prefer stable interaction_id when present so legitimate repeated prompts
   * in the same conversation are not dropped as duplicates.
   */
  private hashInteraction(interaction: any): string {
    if (interaction?.interaction_id) {
      return `id:${interaction.interaction_id}`
    }

    // Use type + conversation_id + first 200 chars of content as a unique identifier
    // Timestamp is deliberately excluded so near-simultaneous duplicates are caught
    const contentPrefix = (interaction.content || '').substring(0, 200)
    const conversationId = interaction.conversation_id || 'no-convo'
    return `${interaction.type}:${conversationId}:${contentPrefix}`
  }

  /**
   * Build a stable fingerprint for completed Q&A payloads.
   * Prefer interaction IDs and parser timestamps so same/similar text is not
   * over-collapsed across distinct turns.
   */
  private hashQaPair(question: any, response: any): string {
    const source = String(response?.source || question?.source || '')
    const questionInteractionId = String(question?.interaction_id || '')
    const responseInteractionId = String(response?.interaction_id || '')

    // Best case: both IDs exist and uniquely identify the turn pair.
    if (questionInteractionId && responseInteractionId) {
      return ['idpair', source, questionInteractionId, responseInteractionId].join('|')
    }

    const normalize = (value: unknown): string =>
      String(value || '')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 500)

    const questionTs = Number(question?.question_timestamp ?? question?.timestamp ?? 0)
    const responseTs = Number(response?.response_timestamp ?? response?.timestamp ?? 0)

    return [
      'tscontent',
      source,
      String(questionTs),
      String(responseTs),
      normalize(question?.content),
      normalize(response?.content),
    ].join('|')
  }

  private persistQaHashes(): void {
    const serialized = Array.from(this.transmittedQaHashes).slice(-this.QA_HASH_MAX_SIZE)
    chrome.storage.local.set({ [this.QA_HASH_STORAGE_KEY]: serialized })
  }

  /**
   * Generates a safe fallback conversation key when conversation_id is missing.
   * This prevents collisions by using source, tab/referrer info, and timestamp.
   * Format: 'fallback_{source}_{sanitized_tab_id}_{ms_since_epoch}'
   */
  private generateFallbackConversationKey(interaction: any): string {
    const source = (interaction?.source || 'unknown').replace(/[^a-z0-9_]/gi, '_')
    const tabId = (interaction?.tab_id || 'notab').toString().slice(0, 20).replace(/[^a-z0-9_]/gi, '_')
    const questionTs = Math.floor((interaction?.timestamp ?? Date.now()) / 1000) // Convert to seconds for shorter key
    
    // Log the fallback key generation for debugging
    console.warn(
      `[LLM Chatbot] Generated fallback conversation key (no conversation_id from ${source}): ${source}_${tabId}_${questionTs}`
    )
    
    return `fallback_${source}_${tabId}_${questionTs}`
  }

  private handleInteractionBatch(interactions: any[]): void {
    console.log(`[LLM Chatbot] Service Worker received batch of ${interactions.length} interactions`)
    
    // DEBUG: Log what we actually received
    for (const interaction of interactions) {
      if (interaction.type === 'response') {
        console.log(`[LLM Chatbot] DEBUG - Received response with sources: ${JSON.stringify(interaction.sources ? interaction.sources.length + ' sources' : 'NO SOURCES')}`)
      }
    }

    // Filter out already-transmitted interactions
    const newInteractions = interactions.filter(interaction => {
      const hash = this.hashInteraction(interaction)
      if (this.transmittedHashes.has(hash)) {
        console.log(`[LLM Chatbot] Skipping duplicate interaction: ${interaction.type}`)
        return false
      }
      return true
    })

    if (newInteractions.length === 0) {
      console.log('[LLM Chatbot] All interactions were duplicates, nothing to transmit')
      return
    }

    console.log(`[LLM Chatbot] Processing ${newInteractions.length} new interactions (${interactions.length - newInteractions.length} duplicates filtered)`)
    
    // Process for transmission
    this.processInteractionsForTransmission(newInteractions)
  }

  private processInteractionsForTransmission(interactions: any[]): void {
    if (interactions.length === 0) return

    console.log(`[LLM Chatbot] Transmitting ${interactions.length} interactions to PDK`)

    const markTransmitted = (interaction: any) => {
      const hash = this.hashInteraction(interaction)
      this.transmittedHashes.add(hash)
    }

    const sortedInteractions = [...interactions].sort((a, b) => {
      const aTs = Number(a?.timestamp ?? 0)
      const bTs = Number(b?.timestamp ?? 0)
      return aTs - bTs
    })

    for (const interaction of sortedInteractions) {
      // Use conversation_id if available, otherwise generate a unique fallback key
      const conversationKey = interaction?.conversation_id ? 
        interaction.conversation_id : 
        this.generateFallbackConversationKey(interaction)

      if (interaction?.type === 'question') {
        // Keep only the latest pending question per conversation and dispatch only with a response.
        this.pendingQuestionByConversation.set(conversationKey, interaction)
        this.questionTimestamps.set(conversationKey, Date.now()) // Track when this question was added
        
        // Check if there are any early responses waiting for this question
        const earlyResponses = this.getAndCleanEarlyResponses(conversationKey)
        for (const earlyResponse of earlyResponses) {
          const validationResult = this.validateTimestampOrdering(interaction, earlyResponse)
          if (validationResult.isValid) {
            console.log(
              `[LLM Chatbot] Processing early response that arrived before question (skew: ${validationResult.skewMs}ms)`
            )
            // Re-insert this response to be processed
            sortedInteractions.push(earlyResponse)
          }
        }
        continue
      }

      if (interaction?.type === 'response') {
        const pendingQuestion = this.pendingQuestionByConversation.get(conversationKey)

        if (pendingQuestion) {
          // Validate timestamp ordering before correlation
          const validationResult = this.validateTimestampOrdering(pendingQuestion, interaction)
          if (!validationResult.isValid) {
            // Clock skew detected: response arrived before question
            this.storeEarlyResponse(conversationKey, interaction)
            markTransmitted(interaction)
            continue
          }

          const qaHash = this.hashQaPair(pendingQuestion, interaction)

          if (this.transmittedQaHashes.has(qaHash)) {
            // Allow re-transmission if sources were enriched after initial dispatch
            const hasNewSources = interaction.sources && interaction.sources.length > 0
            const hadSourcesOnInitialTransmit = this.transmittedQaHashesWithSources.has(qaHash)
            
            if (!hasNewSources || hadSourcesOnInitialTransmit) {
              // Skip: either no new sources, or sources were already present before
              markTransmitted(pendingQuestion)
              markTransmitted(interaction)
              this.pendingQuestionByConversation.delete(conversationKey)
              this.questionTimestamps.delete(conversationKey) // Clean up timestamp tracking
              console.log(`[LLM Chatbot] Skipped duplicate qa_pair from ${interaction.source} (conversation: ${interaction.conversation_id})`)
              continue
            }
            // Fall through: Allow re-transmission with newly-enriched sources
            console.log(`[LLM Chatbot] Re-transmitting qa_pair with newly-enriched sources (${interaction.sources.length} sources)`)
          }

          const hasPageActions = Array.isArray(interaction.page_actions) && interaction.page_actions.length > 0
          const interactionPayload: Record<string, unknown> = {
            url: interaction.url ?? pendingQuestion.url,
            conversation_id: interaction.conversation_id ?? pendingQuestion.conversation_id ?? null,
            interaction_id: interaction.interaction_id ?? null,
            updates_interaction_id: interaction.updates_interaction_id ?? null,
            correlation_id: interaction.interaction_id ?? interaction.updates_interaction_id ?? null,
            question_timestamp: pendingQuestion.question_timestamp ?? pendingQuestion.timestamp ?? null,
            response_timestamp: interaction.timestamp ?? null,
            question: {
              content: pendingQuestion.content,
              length: pendingQuestion.length ?? pendingQuestion.content?.length ?? 0,
            },
            response: {
              content: interaction.content,
              length: interaction.length ?? interaction.content?.length ?? 0,
              sources: interaction.sources ?? [],
              source_extraction: Array.isArray(interaction.sources) && interaction.sources.length > 0
                ? (interaction.source_extraction ?? 'success')
                : 'none',
              // Raw sources-panel HTML captured alongside extraction
              // (Perplexity only, so far) -- present in addition to, not
              // instead of, the separate chatbot-html-snapshot capture with
              // captureType 'sources'.
              sources_html: interaction.sources_html ?? null,
            },
          }

          if (hasPageActions) {
            interactionPayload.page_actions = interaction.page_actions
            interactionPayload.page_actions_summary = interaction.page_actions_summary ?? {
              captured_count: interaction.page_actions.length,
              first_ts: interaction.page_actions[0]?.ts ?? null,
              last_ts: interaction.page_actions[interaction.page_actions.length - 1]?.ts ?? null,
            }
          }

          {
            const chatbotName = interaction.source ?? pendingQuestion.source ?? 'unknown'

            dispatchEvent({
              name: `chatbot-interaction-${chatbotName}`,
              event_name: 'chatbot-interaction',
              generatorId: `chatbot-interaction-${chatbotName}`,
              interaction: interactionPayload,
              chatbot_name: chatbotName,
              secondary_identifier: chatbotName,
            })
          }

          markTransmitted(pendingQuestion)
          markTransmitted(interaction)
          this.pendingQuestionByConversation.delete(conversationKey)
          this.questionTimestamps.delete(conversationKey) // Clean up timestamp tracking
          this.transmittedQaHashes.add(qaHash)
          
          // Track if this hash was transmitted with sources
          if (interaction.sources && interaction.sources.length > 0) {
            this.transmittedQaHashesWithSources.add(qaHash)
          }
          
          if (this.transmittedQaHashes.size > this.QA_HASH_MAX_SIZE) {
            const oldest = this.transmittedQaHashes.values().next().value
            if (oldest) {
              this.transmittedQaHashes.delete(oldest)
              this.transmittedQaHashesWithSources.delete(oldest) // Also clean up sources tracking
            }
          }
          this.persistQaHashes()

          console.log(`[LLM Chatbot] Dispatched combined qa_pair from ${interaction.source} (conversation: ${interaction.conversation_id})`)
          continue
        }

        // Complete Q&A mode: skip unpaired responses.
        markTransmitted(interaction)
        console.log(`[LLM Chatbot] Skipped unpaired response from ${interaction.source} (conversation: ${interaction.conversation_id})`)
        continue
      }

      // Complete Q&A mode: mark unpaired interactions as handled without dispatch.
      markTransmitted(interaction)
      console.log(`[LLM Chatbot] Skipped unpaired ${interaction.type} from ${interaction.source} (conversation: ${interaction.conversation_id})`)
    }

    // Clear storage (browser module may have stored these)
    chrome.storage.local.set({ llm_interactions: [] })
    
    console.log(`[LLM Chatbot] Transmission complete. Total unique interactions tracked: ${this.transmittedHashes.size}`)
  }

  /**
   * Cleans up orphaned questions that have been pending without a response for too long.
   * This prevents memory leaks in the service worker's Map.
   */
  private cleanupOrphanedQuestions(): void {
    const now = Date.now()
    const conversationKeysToDelete: string[] = []

    for (const [conversationKey] of this.pendingQuestionByConversation.entries()) {
      const questionAddedTime = this.questionTimestamps.get(conversationKey)
      if (!questionAddedTime) {
        continue
      }

      const ageMs = now - questionAddedTime
      if (ageMs > this.ORPHANED_QUESTION_TIMEOUT_MS) {
        conversationKeysToDelete.push(conversationKey)
      }
    }

    // Remove orphaned questions
    for (const conversationKey of conversationKeysToDelete) {
      const question = this.pendingQuestionByConversation.get(conversationKey)
      this.pendingQuestionByConversation.delete(conversationKey)
      this.questionTimestamps.delete(conversationKey)
      
      console.log(
        `[LLM Chatbot] Cleaned up orphaned question after ${this.ORPHANED_QUESTION_TIMEOUT_MS / 1000}s (conversation: ${conversationKey}, source: ${question?.source || 'unknown'})`
      )
    }

    if (conversationKeysToDelete.length > 0) {
      console.log(`[LLM Chatbot] Orphaned question cleanup: removed ${conversationKeysToDelete.length} pending questions`)
    }
  }

  /**
   * Evicts turn-count state for conversations that have gone idle, so the
   * Map doesn't grow unbounded across long sessions. Longer timeout than
   * ORPHANED_QUESTION_TIMEOUT_MS since a real conversation can have long
   * gaps between turns without having actually ended.
   */
  private cleanupStaleConversationTurnCounts(): void {
    const now = Date.now()
    const staleKeys: string[] = []

    for (const [conversationKey, lastSeenAt] of this.conversationTurnLastSeenAt.entries()) {
      if (now - lastSeenAt > this.CONVERSATION_TURN_IDLE_TIMEOUT_MS) {
        staleKeys.push(conversationKey)
      }
    }

    for (const conversationKey of staleKeys) {
      this.conversationTurnCounts.delete(conversationKey)
      this.conversationTurnLastSeenAt.delete(conversationKey)
    }

    if (staleKeys.length > 0) {
      console.log(`[LLM Chatbot] Conversation turn-count cleanup: removed ${staleKeys.length} idle conversations`)
    }
  }

  /**
   * Returns the 1-based turn number for a question in its conversation,
   * incrementing and persisting the per-conversation counter.
   *
   * A conversation's first question always arrives with no conversation_id
   * (the platform hasn't assigned/exposed one yet at submit time), so it's
   * tracked under a per-platform anonymous placeholder key rather than
   * unconditionally returning 1 -- that placeholder's count is what a later
   * question in the same conversation reconciles onto once a real id
   * appears (see below), so turn numbering survives the id transition
   * instead of silently restarting at 1.
   */
  private nextConversationTurnNumber(chatbotName: string, conversationId: string | null | undefined): number {
    const anonymousKey = `__anon__:${chatbotName}`

    if (!conversationId) {
      const previousCount = this.conversationTurnCounts.get(anonymousKey) ?? 0
      const turnNumber = previousCount + 1
      this.conversationTurnCounts.set(anonymousKey, turnNumber)
      this.conversationTurnLastSeenAt.set(anonymousKey, Date.now())
      this.lastActiveConversationKeyByPlatform.set(chatbotName, anonymousKey)
      return turnNumber
    }

    // First time this real id is seen: if the platform's most recently
    // active conversation was still the anonymous placeholder (i.e. no
    // other real conversation has started on this platform since), treat
    // this as that same conversation gaining an id, and continue its count
    // rather than starting a fresh one at turn 1. Bounded by the idle
    // window so a stale placeholder from an unrelated, long-finished
    // conversation can't be reconciled onto a new one.
    if (!this.conversationTurnCounts.has(conversationId)) {
      const lastActiveKey = this.lastActiveConversationKeyByPlatform.get(chatbotName)
      if (lastActiveKey === anonymousKey) {
        const anonymousLastSeenAt = this.conversationTurnLastSeenAt.get(anonymousKey) ?? 0
        if (Date.now() - anonymousLastSeenAt <= this.CONVERSATION_TURN_IDLE_TIMEOUT_MS) {
          const carriedCount = this.conversationTurnCounts.get(anonymousKey) ?? 0
          this.conversationTurnCounts.set(conversationId, carriedCount)
          this.conversationTurnCounts.delete(anonymousKey)
          this.conversationTurnLastSeenAt.delete(anonymousKey)
        }
      }
    }

    const previousCount = this.conversationTurnCounts.get(conversationId) ?? 0
    const turnNumber = previousCount + 1

    this.conversationTurnCounts.set(conversationId, turnNumber)
    this.conversationTurnLastSeenAt.set(conversationId, Date.now())
    this.lastActiveConversationKeyByPlatform.set(chatbotName, conversationId)

    return turnNumber
  }

  /**
   * Validates timestamp ordering and detects clock skew issues.
   * Returns information about potential timing issues for observability.
   */
  private validateTimestampOrdering(question: any, response: any): {
    isValid: boolean
    skewDetected: boolean
    skewMs: number
  } {
    const questionTs = Number(question?.question_timestamp ?? question?.timestamp ?? 0)
    const responseTs = Number(response?.response_timestamp ?? response?.timestamp ?? 0)
    
    if (!questionTs || !responseTs) {
      return { isValid: true, skewDetected: false, skewMs: 0 } // Can't validate without timestamps
    }

    const skewMs = responseTs - questionTs
    
    // Allow small tolerance window (50ms) for legitimate timing variance
    if (skewMs < -50) { // Response timestamp is significantly before question
      console.warn(
        `[LLM Chatbot] Clock skew detected: response (${responseTs}) arrived ${Math.abs(skewMs)}ms before question (${questionTs})`
      )
      return { isValid: false, skewDetected: true, skewMs }
    }

    return { isValid: true, skewDetected: false, skewMs }
  }

  /**
   * Stores responses that arrived before their questions for later matching.
   * These will be retried when the question finally arrives.
   */
  private storeEarlyResponse(conversationKey: string, response: any): void {
    if (!this.pendingResponsesByConversation.has(conversationKey)) {
      this.pendingResponsesByConversation.set(conversationKey, [])
    }
    this.pendingResponsesByConversation.get(conversationKey)!.push({
      response,
      arrivedAtMs: Date.now(),
    })
    
    console.warn(
      `[LLM Chatbot] Response arrived before question (stored for later). Conversation: ${conversationKey}, source: ${response?.source}`
    )
  }

  /**
   * Checks if stored early responses are still within the timeout window.
   * Returns responses ready for matching or logs if they're too old.
   */
  private getAndCleanEarlyResponses(conversationKey: string): any[] {
    const stored = this.pendingResponsesByConversation.get(conversationKey)
    if (!stored || stored.length === 0) {
      return []
    }

    const now = Date.now()
    const readyResponses: any[] = []

    for (const entry of stored) {
      const ageMs = now - entry.arrivedAtMs
      if (ageMs <= this.EARLY_RESPONSE_TIMEOUT_MS) {
        readyResponses.push(entry.response)
      } else {
        console.warn(
          `[LLM Chatbot] Discarding early response - too old (${ageMs}ms > ${this.EARLY_RESPONSE_TIMEOUT_MS}ms). Conversation: ${conversationKey}`
        )
      }
    }

    // Remove all entries (either we're processing them or discarding expired ones)
    this.pendingResponsesByConversation.delete(conversationKey)
    return readyResponses
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  checkRequirement(_requirement: string): Promise<boolean> {
    return Promise.resolve(this.enabled)
  }
}

/**
 * ChatGPT Capture Manager
 * Handles both historical chat capture and live message capture for ChatGPT
 */
class ChatGPTCaptureManager {
  private config: any
  private capturedConversationIds = new Set<string>()

  constructor(config: any) {
    this.config = config
    console.log('[ChatGPT Capture] Manager initialized with config:', config)
  }

  /**
   * Main entry point - captures data from ChatGPT page and queues for PDK
   */
  async captureAndQueueData(data: any): Promise<void> {
    console.log('[ChatGPT Capture] captureAndQueueData called with:', data)

    try {
      // Detect login state
      const isLoggedIn = this.detectLoginState()
      console.log('[ChatGPT Capture] Login state:', isLoggedIn ? 'logged-in' : 'logged-out')

      if (isLoggedIn) {
        // Logged-in: capture history + live
        console.log('[ChatGPT Capture] Starting historical chat capture...')
        await this.captureHistoricalChats()
        console.log('[ChatGPT Capture] Historical chat capture completed')
      } else {
        // Logged-out: capture live only
        console.log('[ChatGPT Capture] Logged out - live capture only')
      }

      // Queue data for PDK transmission
      await this.queueForPDKTransmission(data)

    } catch (error) {
      console.error('[ChatGPT Capture] Error in captureAndQueueData:', error)
      throw error
    }
  }

  /**
   * Detects whether user is logged in to ChatGPT
   */
  private detectLoginState(): boolean {
    const loggedInSelector = this.config.login_detection?.loggedInSelector
    const loggedOutSelector = this.config.login_detection?.loggedOutSelector

    const hasProfileBtn = document.querySelector(loggedInSelector)
    const hasLoginBtn = document.querySelector(loggedOutSelector)

    const isLoggedIn = !!hasProfileBtn && !hasLoginBtn
    console.log(`[ChatGPT Capture] Login detection - profile btn: ${!!hasProfileBtn}, login btn: ${!!hasLoginBtn}`)

    return isLoggedIn
  }

  /**
   * Capture all historical chats from sidebar
   * Based on tested script pattern
   */
  private async captureHistoricalChats(): Promise<void> {
    try {
      const sidebarSelector = this.config.selectors?.sidebar  // '#history'
      const sidebarItemsSelector = this.config.selectors?.sidebarItems  // 'a[data-sidebar-item="true"]'

      const chatHistoryDiv = document.querySelector(sidebarSelector)
      if (!chatHistoryDiv) {
        console.log('[ChatGPT Capture] Sidebar not found - likely not logged in')
        return
      }

      const chatLinks = chatHistoryDiv.querySelectorAll(sidebarItemsSelector)
      console.log(`[ChatGPT Capture] Found ${chatLinks.length} historical chats in sidebar`)

      const chatHistory = Array.from(chatLinks).map((link: any) => ({
        title: link.querySelector('span[dir="auto"]')?.textContent?.trim() || 'Untitled',
        conversation_id: link.getAttribute('href')?.split('/c/')[1] || '',
        url: link.getAttribute('href') || '',
        element: link
      }))

      console.log('[ChatGPT Capture] Chat history extracted:', chatHistory.length, 'items')

      // Process each historical chat
      for (const chat of chatHistory) {
        if (!chat.conversation_id || this.capturedConversationIds.has(chat.conversation_id)) {
          console.log(`[ChatGPT Capture] Skipping chat (already captured or invalid): ${chat.title}`)
          continue
        }

        console.log(`[ChatGPT Capture] Processing historical chat: ${chat.title}`)

        try {
          // Click on chat to load it
          (chat.element as HTMLElement).click()

          // Wait for page to load
          await this.waitForLoad(2000)

          // Capture messages and sources
          const capturedData = this.captureMessagesAndSources()
          console.log(`[ChatGPT Capture] Captured ${capturedData.messages.length} message pairs from: ${chat.title}`)

          // Mark as captured
          this.capturedConversationIds.add(chat.conversation_id)

          // Queue for PDK
          await this.sendToPDK({
            platform: 'chatgpt',
            state: 'logged-in-history',
            conversation_id: chat.conversation_id,
            conversation_title: chat.title,
            url: chat.url,
            messages: capturedData.messages,
            date: new Date()
          })

        } catch (chatError) {
          console.error(`[ChatGPT Capture] Error processing chat ${chat.title}:`, chatError)
        }
      }

    } catch (error) {
      console.error('[ChatGPT Capture] Error in captureHistoricalChats:', error)
      throw error
    }
  }

  /**
   * Capture messages and sources from current page
   * Based on tested script pattern
   */
  private captureMessagesAndSources(): any {
    const userMessageSelector = this.config.selectors?.userMessage  // '[data-message-author-role="user"]'
    const assistantMessageSelector = this.config.selectors?.assistantMessage  // '[data-message-author-role="assistant"]'

    const userMessages = document.querySelectorAll(userMessageSelector)
    const assistantMessages = document.querySelectorAll(assistantMessageSelector)

    console.log(`[ChatGPT Capture] Found ${userMessages.length} user messages, ${assistantMessages.length} assistant messages`)

    const messages: any[] = []

    for (let i = 0; i < userMessages.length; i++) {
      const userMsg = userMessages[i]
      const assistantMsg = assistantMessages[i]

      if (!userMsg || !assistantMsg) {
        console.warn(`[ChatGPT Capture] Skipping unpaired messages at index ${i}`)
        continue
      }

      // Extract sources from assistant message (links)
      const sources = Array.from(assistantMsg.querySelectorAll('a')).map((link: any) => ({
        source_title: link.textContent?.trim() || '',
        source_url: link.href || ''
      }))

      const message = {
        user_input: userMsg.textContent?.trim() || '',
        assistant_output: assistantMsg.textContent?.trim() || '',
        assistant_sources: sources
      }

      console.log(`[ChatGPT Capture] Message ${i + 1}: user length=${message.user_input.length}, assistant length=${message.assistant_output.length}, sources=${sources.length}`)

      messages.push(message)
    }

    return { messages }
  }

  /**
   * Wait for page to load
   */
  private waitForLoad(ms: number): Promise<void> {
    console.log(`[ChatGPT Capture] Waiting ${ms}ms for page load...`)
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  /**
   * Send captured data to PDK
   */
  private async sendToPDK(data: any): Promise<void> {
    console.log('[ChatGPT Capture] Queuing data for PDK transmission:', {
      conversation_id: data.conversation_id,
      conversation_title: data.conversation_title,
      message_count: data.messages?.length || 0
    })

    // PDK dispatch suppressed: chatbot interactions captured but not sent to PDK.
    // dispatchEvent({ name: 'rex-live-mirror', ... }) intentionally disabled.
    console.log('[ChatGPT Capture] PDK dispatch suppressed (sendToPDK no-op)')
  }

  /**
   * Queue data for PDK transmission
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async queueForPDKTransmission(_data: any): Promise<void> {
    console.log('[ChatGPT Capture] queueForPDKTransmission called')
    // Intentionally no-op in current flow; live dispatch happens in handleInteractionBatch().
  }

  /**
   * User-initiated sync of historical chats using background tabs
   * Opens chats in hidden tabs, captures, closes without interrupting user
   */
  async syncHistoricalChatsInBackground(): Promise<void> {
    try {
      console.log('[ChatGPT Capture] Starting background historical sync (user-initiated)...')

      const sidebarSelector = this.config.selectors?.sidebar  // '#history'
      const sidebarItemsSelector = this.config.selectors?.sidebarItems  // 'a[data-sidebar-item="true"]'

      const chatHistoryDiv = document.querySelector(sidebarSelector)
      if (!chatHistoryDiv) {
        console.log('[ChatGPT Capture] Sidebar not found - user likely not logged in')
        throw new Error('ChatGPT sidebar not available - please log in')
      }

      const chatLinks = chatHistoryDiv.querySelectorAll(sidebarItemsSelector)
      console.log(`[ChatGPT Capture] Found ${chatLinks.length} historical chats to sync`)

      const chatHistory = Array.from(chatLinks).map((link: any) => ({
        title: link.querySelector('span[dir="auto"]')?.textContent?.trim() || 'Untitled',
        conversation_id: link.getAttribute('href')?.split('/c/')[1] || '',
        url: link.getAttribute('href') || ''
      }))

      let syncedCount = 0
      let skippedCount = 0

      // Process each chat in background tab
      for (const chat of chatHistory) {
        if (!chat.conversation_id || this.capturedConversationIds.has(chat.conversation_id)) {
          console.log(`[ChatGPT Capture] Skipping (already captured): ${chat.title}`)
          skippedCount++
          continue
        }

        try {
          console.log(`[ChatGPT Capture] Background sync: opening ${chat.title}...`)

          // Open chat in background tab (user doesn't see it)
          await this.captureInBackgroundTab(chat)
          syncedCount++

        } catch (error) {
          console.error(`[ChatGPT Capture] Error syncing ${chat.title}:`, error)
        }
      }

      console.log(`[ChatGPT Capture] Background sync complete: synced=${syncedCount}, skipped=${skippedCount}`)

    } catch (error) {
      console.error('[ChatGPT Capture] Error in syncHistoricalChatsInBackground:', error)
      throw error
    }
  }

  /**
   * Capture a single chat using a background tab
   * Opens tab → captures messages → closes tab (no user interruption)
   */
  private captureInBackgroundTab(chat: any): Promise<void> {
    return new Promise((resolve, reject) => {
      console.log(`[ChatGPT Capture] Creating background tab for: ${chat.title}`)

      // Open in background tab (user doesn't see it)
      chrome.tabs.create({
        url: chat.url,
        active: false,  // ← KEY: Don't steal focus
        windowId: chrome.windows.WINDOW_ID_CURRENT
      }, async (backgroundTab) => {
        if (!backgroundTab || !backgroundTab.id) {
          reject(new Error('Failed to create background tab'))
          return
        }

        const tabId = backgroundTab.id
        console.log(`[ChatGPT Capture] Background tab created: ${tabId}`)

        try {
          // Wait for tab to fully load
          await this.waitForLoad(3000)

          console.log(`[ChatGPT Capture] Capturing from background tab: ${chat.title}`)

          // Send capture request to tab's content script
          const captured = await new Promise<any>((captureResolve, captureReject) => {
            chrome.tabs.sendMessage(tabId, {
                messageType: 'captureMessagesFromTab',
                conversationId: chat.conversation_id,
                selectors: this.config.selectors
              }, {}, (response) => {
                if (response?.success) {
                  captureResolve(response.data)
                } else {
                  captureReject(new Error(response?.error || 'Capture failed'))
                }
              }
            )
          })

          console.log(`[ChatGPT Capture] Captured ${captured.messages.length} messages from background tab`)

          // Mark as captured
          this.capturedConversationIds.add(chat.conversation_id)

          // Queue for PDK
          await this.sendToPDK({
            platform: 'chatgpt',
            state: 'background-sync-history',
            conversation_id: chat.conversation_id,
            conversation_title: chat.title,
            url: chat.url,
            messages: captured.messages,
            sync_method: 'background-tab',
            date: new Date()
          })

          console.log(`[ChatGPT Capture] Closing background tab: ${tabId}`)
          // Close the background tab (cleanup)
          chrome.tabs.remove(tabId)

          resolve()

        } catch (error) {
          console.error(`[ChatGPT Capture] Error processing background tab:`, error)
          // Always close the tab even on error
          chrome.tabs.remove(tabId)
          reject(error)
        }
      })
    })
  }
}

const llmChatbotModule = new LLMChatbotServiceWorkerModule()
registerREXModule(llmChatbotModule)

export default llmChatbotModule
export { pageCaptureSWModule }
