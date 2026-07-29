import { REXClientModule, registerREXModule } from '@bric/rex-core/browser'

/**
 * Page HTML Capture Browser Module
 * 
 * Periodically captures page HTML on supported platforms (chatbots, etc.)
 * and sends to service worker for storage and linkage with interactions.
 * 
 * Configurable via backend `page_html_capture` config block.
 */

export interface PageHtmlCaptureConfig {
  enabled?: boolean
  fullPageFallbackEnabled?: boolean
  platformConfigs?: {
    [platform: string]: {
      enabled: boolean
      // NOTE: no longer "how often to capture Q&A" -- that capture is now
      // event-driven, fired from triggerQuestionSubmitCapture() the instant
      // a question is submitted, not on a timer. This field now only
      // controls how often maybeCapturePeriodicFullPageSnapshots() re-checks
      // whether the scoped Q&A container can be resolved at all, and (only
      // if it still cannot be) re-attempts the full-page-fallback capture.
      // Kept the same config key name for backward compatibility with
      // already-deployed backend configs.
      captureIntervalMs: number
      intervalMs?: number
      emitOnlyOnChange?: boolean
      containerSelector?: string // Primary: container holding Q&A (e.g., div[role='main'], main, chat-window-content)
      qaSelector?: string // Q&A message elements
      sourceSelector?: string // Source/citation links
      snapshotSelectors?: SnapshotSelectors
      sourceCapture?: SourceCaptureConfig
      fullPageFallbackEnabled?: boolean
    }
  }
}

type SnapshotSelectors = {
  question?: string
  response?: string
  responseContainer?: string
}

type SourceCaptureConfig = {
  enabled?: boolean
  inactivityThresholdMs?: number  // ms user must be idle before toggling (default 5000)
  stableSnapshotCount?: number    // consecutive unchanged QA snapshots before source pull (default 2)
  sourceToggleSelector?: string   // button that opens the sources panel
  sourcePanelSelector?: string    // element to verify panel opened
  sourceCloseSelector?: string    // element to close panel (falls back to re-clicking toggle)
  panelWaitMs?: number            // ms to wait after click before capturing (default 800)
  panelOutsideContainer?: boolean // true when sourcePanelSelector renders as a sibling of containerSelector rather than inside it (e.g. ChatGPT's Sources flyout) — captures document.body instead of the scoped container so the panel content isn't dropped
}

type SourceStabilityState = {
  lastQaFingerprint: string | null
  stableQaCount: number
  lastSourcesFingerprint: string | null
}

type PeriodicFullPageCaptureState = {
  lastCheckedAtMs: number
  lastFingerprint: string | null
}

type ChatbotSelectors = {
  userMessage?: string
  userQuestion?: string
  assistantMessage?: string
  assistantResponse?: string
  responseContainer?: string
}

type AppConfiguration = {
  llm_capture?: {
    platforms?: {
      [platform: string]: {
        enabled?: boolean
        captureIntervalMs?: number
        selectors?: ChatbotSelectors
      }
    }
  }
}

class PageHtmlCaptureBrowserModule extends REXClientModule {
  private enabled: boolean = false
  private config: PageHtmlCaptureConfig | null = null
  private appConfiguration: AppConfiguration | null = null
  private periodicFullPageCaptureIntervalId: NodeJS.Timeout | null = null
  private captureSequence: number = 0
  private interactionCorrelationId: string | null = null // Link captures to interactions
  private interactionCorrelationSetAtMs: number = 0
  private lastCaptureTimestamp: number = 0
  private lastUserActivityAt: number = Date.now()
  private isSourceCaptureLocked: boolean = false
  private listenersInstalled: boolean = false
  private sourceStabilityByPlatform: Map<string, SourceStabilityState> = new Map()
  private periodicFullPageCaptureStateByPlatform: Map<string, PeriodicFullPageCaptureState> = new Map()
  private lastDispatchedQaFingerprint: Map<string, string> = new Map() // Track sent QA snapshots to avoid duplicates
  private readonly MIN_CAPTURE_INTERVAL_MS = 5000 // Don't capture faster than 5 seconds
  private readonly DEFAULT_PERIODIC_FULL_PAGE_CAPTURE_INTERVAL_MS = 45000
  private readonly MAX_CAPTURES_PER_SESSION = 1000 // Memory safety
  private readonly MAX_CORRELATION_AGE_MS = 30000 // Prevent stale join keys from leaking across turns

  // Submit-triggered capture: fires as soon as a response completes (or a
  // timeout ceiling elapses) instead of waiting on the blind periodic interval.
  private submitCaptureObserver: MutationObserver | null = null
  private submitCapturePollId: ReturnType<typeof setInterval> | null = null
  private submitCaptureTimeoutId: ReturnType<typeof setTimeout> | null = null
  private submitCaptureGeneration = 0
  private readonly SUBMIT_CAPTURE_POLL_MS = 2000
  private readonly SUBMIT_CAPTURE_TIMEOUT_MS = 60000

  constructor() {
    super()
    console.log('[Page HTML Capture] Browser module initialized')
  }

  moduleName(): string {
    return 'PageHtmlCaptureBrowserModule'
  }

  async setup(): Promise<void> {
    // Chrome injects content scripts into every frame matching the host
    // permissions, including embedded iframes (e.g. Perplexity's
    // count.perplexity.ai analytics beacon frame). Without this guard, that
    // frame runs its own independent full-page-fallback interval, wastefully
    // capturing and sending the iframe's own tiny document every cycle --
    // it is always rejected downstream (host not in configured platform
    // hosts), so nothing is lost by skipping it here, only wasted work.
    if (window.top !== window.self) {
      console.log('[Page HTML Capture] Skipping initialization in non-top frame')
      return
    }

    console.log('[Page HTML Capture] Setting up browser module')

    try {
      const configuration = await this.fetchConfiguration()
      this.appConfiguration = configuration
      if (configuration?.page_html_capture?.enabled === true) {
        this.enabled = true
        this.config = configuration.page_html_capture
        console.log('[Page HTML Capture] Enabled with config:', this.config)
        this.startCapture()
      } else {
        console.log('[Page HTML Capture] Disabled - not in configuration or disabled=false')
      }
    } catch (error) {
      console.warn('[Page HTML Capture] Failed to fetch configuration:', error)
    }
  }

  private async fetchConfiguration(): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ messageType: 'fetchConfiguration' })
          .then(resolve)
          .catch(() => resolve(null))
      } catch {
        resolve(null)
      }
    })
  }

  private isPlatformEnabled(platform: string): { enabled: boolean; intervalMs: number } {
    if (!this.config?.platformConfigs?.[platform]) {
      return { enabled: false, intervalMs: 0 }
    }

    const platformConfig = this.config.platformConfigs[platform]
    const intervalMs = Math.max(
      platformConfig.intervalMs ?? platformConfig.captureIntervalMs ?? this.DEFAULT_PERIODIC_FULL_PAGE_CAPTURE_INTERVAL_MS,
      this.MIN_CAPTURE_INTERVAL_MS
    )

    return {
      enabled: platformConfig.enabled === true,
      intervalMs,
    }
  }

  private isFullPageFallbackEnabled(platform: string): boolean {
    const platformOverride = this.config?.platformConfigs?.[platform]?.fullPageFallbackEnabled
    if (typeof platformOverride === 'boolean') {
      return platformOverride
    }

    return this.config?.fullPageFallbackEnabled === true
  }

  /**
   * Check if page has Q&A content using qaSelector from config.
   * Prevents capturing empty/error/loading pages.
   */
  private hasQAContent(platform: string): boolean {
    const platformConfig = this.config?.platformConfigs?.[platform]
    if (!platformConfig?.qaSelector) {
      console.log('[Page HTML Capture] No qaSelector configured for', platform)
      return false
    }

    try {
      const selectors = platformConfig.qaSelector.split(',').map(s => s.trim())
      for (const selector of selectors) {
        const elements = document.querySelectorAll(selector)
        if (elements.length > 0) {
          console.log('[Page HTML Capture] Found Q&A content via selector:', selector)
          return true
        }
      }
    } catch (error) {
      console.warn('[Page HTML Capture] Error checking Q&A content:', error)
    }

    return false
  }

  /**
   * Validate captured HTML has expected Q&A structure based on platform markers.
   * Does NOT reject based on size - only checks for content markers.
   */
  private isValidQACapture(html: string, platform: string): boolean {
    if (!html) {
      return false
    }

    // Check for presence of key Q&A markers based on platform
    const qaMarkers: Record<string, string[]> = {
      chatgpt: ['data-message-role', 'conversation-turn', 'message-author-role'],
      perplexity: ['markdown-content', 'prose', 'group/query'],
      gemini: ['model-response', 'user-query', 'conversation-container'],
      claude: ['message', 'assistant', 'user'],
      copilot: ['message', 'assistant', 'user'],
    }

    const markers = qaMarkers[platform] || []
    if (markers.length === 0) {
      console.log('[Page HTML Capture] No Q&A markers configured for', platform, '- accepting HTML as-is')
      return true  // Unknown platform, accept anyway
    }

    const hasMarker = markers.some(m => html.includes(m))
    if (!hasMarker) {
      console.log('[Page HTML Capture] HTML missing Q&A markers for', platform)
      return false
    }

    return true
  }

  /**
   * Get fallback HTML from body if container validation fails.
   * Prefers minimal content over empty capture.
   */
  private getFallbackHTMLContent(): string {
    const body = document.body?.outerHTML || ''
    if (body.length > 0) {
      console.log('[Page HTML Capture] Using body fallback, size:', body.length)
      return body
    }
    return ''
  }

  private detectPlatform(): string | null {
    const hostname = window.location.hostname
    if (hostname.includes('chatgpt.com')) return 'chatgpt'
    if (hostname.includes('claude.ai')) return 'claude'
    if (hostname.includes('perplexity.ai')) return 'perplexity'
    if (hostname.includes('gemini.google.com')) return 'gemini'
    if (hostname.includes('copilot.microsoft.com')) return 'copilot'
    return null
  }

  private getSnapshotSelectors(platform: string): SnapshotSelectors | null {
    const captureSelectors = this.config?.platformConfigs?.[platform]?.snapshotSelectors
    if (captureSelectors?.question && captureSelectors?.response) {
      return captureSelectors
    }

    const selectors = this.appConfiguration?.llm_capture?.platforms?.[platform]?.selectors
    if (!selectors) {
      return null
    }

    const question = selectors.userMessage ?? selectors.userQuestion
    const response = selectors.assistantMessage ?? selectors.assistantResponse

    if (!question || !response) {
      return null
    }

    return {
      question,
      response,
      responseContainer: selectors.responseContainer,
    }
  }

  private findCommonAncestor(firstElement: Element, secondElement: Element): Element | null {
    let candidate: Element | null = firstElement
    while (candidate) {
      if (candidate.contains(secondElement)) {
        return candidate
      }
      candidate = candidate.parentElement
    }

    return null
  }

  private resolveCaptureRoot(platform: string): Element | null {
    // Priority 1: Try containerSelector (new platform-agnostic approach)
    const platformConfig = this.config?.platformConfigs?.[platform]
    if (platformConfig?.containerSelector) {
      const selectors = platformConfig.containerSelector.split(',').map(s => s.trim())
      let narrowestMatch: Element | null = null
      let narrowestSelector: string | null = null
      let narrowestSize = Infinity
      for (const selector of selectors) {
        const container = document.querySelector(selector)
        if (!container) {
          continue
        }
        // Comma-separated containerSelector entries are alternatives, not a priority
        // order — a broad app-shell selector (e.g. "main") listed before a tighter
        // one (e.g. ".scrollable-container") would otherwise always win just because
        // it comes first, even though both match. Prefer whichever match has the
        // smallest DOM footprint so the scoped Q&A container wins over the app shell.
        const size = container.querySelectorAll('*').length
        if (size < narrowestSize) {
          narrowestMatch = container
          narrowestSelector = selector
          narrowestSize = size
        }
      }
      if (narrowestMatch) {
        console.log('[Page HTML Capture] Found container via containerSelector:', narrowestSelector)
        return narrowestMatch
      }
    }

    // Fallback: Use snapshotSelectors (legacy approach)
    const selectors = this.getSnapshotSelectors(platform)
    if (!selectors?.question || !selectors?.response) {
      return null
    }

    const questionElements = Array.from(document.querySelectorAll(selectors.question))
    const responseElements = Array.from(document.querySelectorAll(selectors.response))

    if (questionElements.length === 0 || responseElements.length === 0) {
      return null
    }

    if (selectors.responseContainer) {
      const responseContainers = Array.from(document.querySelectorAll(selectors.responseContainer))
      for (let index = responseContainers.length - 1; index >= 0; index -= 1) {
        const container = responseContainers[index]
        if (
          container.querySelector(selectors.question) !== null
          && container.querySelector(selectors.response) !== null
        ) {
          return container
        }
      }
    }

    const latestQuestion = questionElements[questionElements.length - 1]
    const latestResponse = responseElements[responseElements.length - 1]
    return this.findCommonAncestor(latestQuestion, latestResponse)
  }

  private getPeriodicFullPageCaptureState(platform: string): PeriodicFullPageCaptureState {
    const existing = this.periodicFullPageCaptureStateByPlatform.get(platform)
    if (existing) {
      return existing
    }

    const created: PeriodicFullPageCaptureState = {
      lastCheckedAtMs: 0,
      lastFingerprint: null,
    }
    this.periodicFullPageCaptureStateByPlatform.set(platform, created)
    return created
  }

  private buildPeriodicFullPageFingerprint(platform: string, pageHtml: string): string {
    const normalized = pageHtml.replace(/\s+/g, ' ').trim()
    const head = normalized.slice(0, 1024)
    const tail = normalized.slice(Math.max(0, normalized.length - 1024))
    return [platform, window.location.href, String(normalized.length), head, tail].join('|')
  }

  private async captureFullPageFromTabWithRetries(maxRetries: number = 3): Promise<string | null> {
    const retryDelaysMs = [0, 1500, 3500]

    for (let attempt = 0; attempt < maxRetries; attempt += 1) {
      if (retryDelaysMs[attempt] > 0) {
        await new Promise<void>(resolve => { setTimeout(resolve, retryDelaysMs[attempt]) })
      }

      const root = document.documentElement
      const html = root?.outerHTML || document.body?.outerHTML || ''
      if (html.trim().length > 0) {
        return html
      }
    }

    return null
  }

  private startCapture(): void {
    const platform = this.detectPlatform()
    if (!platform) {
      console.log('[Page HTML Capture] Not on a supported platform')
      return
    }

    const { enabled } = this.isPlatformEnabled(platform)
    if (!enabled) {
      console.log('[Page HTML Capture] Platform not enabled:', platform)
      return
    }

    console.log('[Page HTML Capture] Starting event-driven capture on', platform)

    this.stopPeriodicFullPageCapture()

    // No blind periodic QA capture and no immediate capture here: with no
    // question submitted yet, there is nothing to capture. QA captures are
    // now driven entirely by triggerQuestionSubmitCapture(), called the
    // instant a question is submitted (see LLMChatbotBrowserModule). Note
    // this deliberately does not call stopSubmitCaptureWatch() -- a watch
    // already armed for an in-flight turn (e.g. from before a visibility
    // change) must survive a restart of this method.
    if (this.isFullPageFallbackEnabled(platform)) {
      this.startPeriodicFullPageCapture(platform)
    }
  }

  private startPeriodicFullPageCapture(platform: string): void {
    this.stopPeriodicFullPageCapture()

    const intervalMs = Math.max(
      this.config?.platformConfigs?.[platform]?.intervalMs
        ?? this.config?.platformConfigs?.[platform]?.captureIntervalMs
        ?? this.DEFAULT_PERIODIC_FULL_PAGE_CAPTURE_INTERVAL_MS,
      this.MIN_CAPTURE_INTERVAL_MS,
    )

    console.log('[Page HTML Capture] Starting periodic full-page capture on', platform, 'interval:', intervalMs)
    void this.maybeCapturePeriodicFullPageSnapshots(platform)

    this.periodicFullPageCaptureIntervalId = setInterval(() => {
      void this.maybeCapturePeriodicFullPageSnapshots(platform)
    }, intervalMs)
  }

  private stopPeriodicFullPageCapture(): void {
    if (this.periodicFullPageCaptureIntervalId !== null) {
      clearInterval(this.periodicFullPageCaptureIntervalId)
      this.periodicFullPageCaptureIntervalId = null
    }
  }

  private stopSubmitCaptureWatch(): void {
    if (this.submitCaptureObserver) {
      this.submitCaptureObserver.disconnect()
      this.submitCaptureObserver = null
    }
    if (this.submitCapturePollId !== null) {
      clearInterval(this.submitCapturePollId)
      this.submitCapturePollId = null
    }
    if (this.submitCaptureTimeoutId !== null) {
      clearTimeout(this.submitCaptureTimeoutId)
      this.submitCaptureTimeoutId = null
    }
  }

  /**
   * Called when the browser module observes the user submit a question
   * (Enter / send button), before any response exists. Replaces waiting on
   * the blind periodic captureIntervalMs tick with an event-driven capture
   * fired as soon as the response actually completes.
   *
   * isResponseComplete is supplied by the caller (LLMChatbotBrowserModule),
   * which already owns the per-platform parser and its completion selectors
   * -- this module has no parser of its own and should not fork a second
   * copy of those selectors.
   *
   * Two independent detection paths run concurrently, plus a hard timeout:
   *   1. MutationObserver -- fast path, fires as soon as the completing
   *      mutation happens. Not relied on alone: if the observer is armed
   *      after the DOM has already settled (same-tick render) or the
   *      configured completion selectors are stale/wrong, it may never see
   *      a matching mutation at all.
   *   2. A plain poll on its own timer (SUBMIT_CAPTURE_POLL_MS) -- does not
   *      depend on any DOM mutation firing, so it still catches completion
   *      even if the observer never triggers.
   *   3. A hard timeout ceiling (SUBMIT_CAPTURE_TIMEOUT_MS) -- captures
   *      whatever is on the page even if isResponseComplete never returns
   *      true, so a broken/stale completion selector degrades to "capture
   *      once at timeout" rather than "never capture." The separate
   *      periodic full-page-fallback interval (for when the scoped Q&A
   *      container cannot be resolved at all) still runs independently of
   *      this; there is no longer a blind periodic QA capture.
   *
   * A generation counter invalidates any previous watch when a new question
   * is submitted before the prior one resolved, so an in-flight turn cannot
   * fire a capture for a later turn.
   */
  public triggerQuestionSubmitCapture(platform: string, isResponseComplete: () => boolean): void {
    if (!this.enabled) {
      return
    }
    const { enabled } = this.isPlatformEnabled(platform)
    if (!enabled) {
      return
    }

    this.stopSubmitCaptureWatch()
    const generation = ++this.submitCaptureGeneration

    const finish = (reason: string): void => {
      // Guards against a later submit having superseded this watch entirely.
      // A second finish() call for the *same* watch is not possible here:
      // stopSubmitCaptureWatch() below synchronously disconnects the
      // observer (which discards any already-queued mutation records) and
      // clears the poll/timeout, and JS's run-to-completion semantics mean
      // no other callback can be mid-execution while this one runs.
      if (generation !== this.submitCaptureGeneration) {
        return
      }
      this.stopSubmitCaptureWatch()
      console.log('[Page HTML Capture] Submit-triggered capture firing:', { platform, reason })
      // isFinal: true -- this is a deliberate, once-per-turn, high-value
      // capture, not a frequent poll. Passing false would subject it to the
      // 1s cross-caller throttle (shared with the full-page-fallback
      // interval and the visibility-change flush) and the QA
      // unchanged-fingerprint skip, either of which could silently drop
      // exactly the capture we most want -- the completed answer. true
      // also lets the full-page fallback actually run here if the scoped
      // container cannot be resolved, instead of silently no-op'ing.
      void this.captureAndSend(platform, true)
    }

    const checkNow = (): boolean => {
      let complete = false
      try {
        complete = isResponseComplete()
      } catch (error) {
        console.warn('[Page HTML Capture] isResponseComplete check failed:', error)
      }
      if (complete) {
        finish('completion-signal')
      }
      return complete
    }

    // Immediate check in case the answer already rendered before this was
    // called (e.g. a fast cached response, or arming after the fact).
    if (checkNow()) {
      return
    }

    this.submitCaptureObserver = new MutationObserver(() => {
      checkNow()
    })
    this.submitCaptureObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    })

    this.submitCapturePollId = setInterval(() => {
      checkNow()
    }, this.SUBMIT_CAPTURE_POLL_MS)

    this.submitCaptureTimeoutId = setTimeout(() => {
      finish('timeout-ceiling')
    }, this.SUBMIT_CAPTURE_TIMEOUT_MS)

    console.log('[Page HTML Capture] Armed submit-triggered capture watch for', platform)
  }

  private async maybeCapturePeriodicFullPageSnapshots(platform: string): Promise<void> {
    const state = this.getPeriodicFullPageCaptureState(platform)
    const now = Date.now()
    const intervalMs = Math.max(
      this.config?.platformConfigs?.[platform]?.intervalMs
        ?? this.config?.platformConfigs?.[platform]?.captureIntervalMs
        ?? this.DEFAULT_PERIODIC_FULL_PAGE_CAPTURE_INTERVAL_MS,
      this.MIN_CAPTURE_INTERVAL_MS,
    )

    if (state.lastCheckedAtMs > 0 && (now - state.lastCheckedAtMs) < intervalMs) {
      return
    }

    // Full-page capture is a last resort: only run it when the scoped Q&A
    // container can't currently be resolved. When containerSelector (or the
    // legacy snapshotSelectors ancestor search) is matching fine, there is no
    // need to also ship the entire raw document on this interval.
    if (this.resolveCaptureRoot(platform)) {
      state.lastCheckedAtMs = now
      console.log('[Page HTML Capture] Skipping periodic full-page capture - scoped Q&A container is resolving fine', {
        platform,
      })
      return
    }

    const pageHtml = await this.captureFullPageFromTabWithRetries()
    if (!pageHtml) {
      state.lastCheckedAtMs = now
      return
    }

    const fingerprint = this.buildPeriodicFullPageFingerprint(platform, pageHtml)
    const emitOnlyOnChange = this.config?.platformConfigs?.[platform]?.emitOnlyOnChange !== false

    if (emitOnlyOnChange && state.lastFingerprint === fingerprint) {
      state.lastCheckedAtMs = now
      console.log('[Page HTML Capture] Skipping periodic full-page capture - HTML unchanged', {
        platform,
        fingerprint,
      })
      return
    }

    state.lastCheckedAtMs = now
    state.lastFingerprint = fingerprint

    await this.sendFullPageCapture(platform, pageHtml, false)
  }

  private computeHtmlFingerprint(value: string): string {
    // Normalize volatile spacing to reduce false negatives from cosmetic DOM churn.
    const normalized = value.replace(/\s+/g, ' ').trim()

    // Lightweight deterministic hash; avoids external dependencies.
    let hash = 0
    for (let index = 0; index < normalized.length; index += 1) {
      hash = ((hash << 5) - hash) + normalized.charCodeAt(index)
      hash |= 0
    }

    return `${normalized.length}:${hash}`
  }

  private getSourceStabilityState(platform: string): SourceStabilityState {
    const existing = this.sourceStabilityByPlatform.get(platform)
    if (existing) {
      return existing
    }

    const created: SourceStabilityState = {
      lastQaFingerprint: null,
      stableQaCount: 0,
      lastSourcesFingerprint: null,
    }
    this.sourceStabilityByPlatform.set(platform, created)
    return created
  }

  private getActiveCorrelationId(referenceTimestampMs: number): string | null {
    if (!this.interactionCorrelationId) {
      return null
    }

    if ((referenceTimestampMs - this.interactionCorrelationSetAtMs) > this.MAX_CORRELATION_AGE_MS) {
      return null
    }

    return this.interactionCorrelationId
  }

  private updateSourceStability(platform: string, captureType: 'qa' | 'full_page', pageHtml: string): void {
    if (captureType !== 'qa') {
      return
    }

    const fingerprint = this.computeHtmlFingerprint(pageHtml)
    const state = this.getSourceStabilityState(platform)

    if (state.lastQaFingerprint === fingerprint) {
      state.stableQaCount += 1
    } else {
      state.lastQaFingerprint = fingerprint
      state.stableQaCount = 1
    }
  }

  private shouldAttemptSourcesCapture(platform: string, stableSnapshotCount: number): {
    ready: boolean
    fingerprint: string | null
  } {
    const state = this.getSourceStabilityState(platform)
    const requiredStableCount = Math.max(2, stableSnapshotCount)

    if (!state.lastQaFingerprint || state.stableQaCount < requiredStableCount) {
      return { ready: false, fingerprint: state.lastQaFingerprint }
    }

    if (state.lastSourcesFingerprint === state.lastQaFingerprint) {
      return { ready: false, fingerprint: state.lastQaFingerprint }
    }

    return { ready: true, fingerprint: state.lastQaFingerprint }
  }

  private async captureAndSend(platform: string, isFinal: boolean): Promise<void> {
    if (this.captureSequence >= this.MAX_CAPTURES_PER_SESSION) {
      console.warn('[Page HTML Capture] Max captures reached for this session')
      return
    }

    // Throttle: don't send more than once per second
    const now = Date.now()
    if (now - this.lastCaptureTimestamp < 1000 && !isFinal) {
      return
    }

    this.lastCaptureTimestamp = now

    try {
      const captureRoot = this.resolveCaptureRoot(platform)
      const allowFullPageFallback = this.isFullPageFallbackEnabled(platform)
      if (!captureRoot && !allowFullPageFallback) {
        console.log('[Page HTML Capture] Skipping capture - Q&A selectors not present', {
          platform,
          url: window.location.href,
        })
        return
      }

      if (!captureRoot) {
        // Before attempting full-page fallback, verify Q&A content exists on page
        if (!this.hasQAContent(platform)) {
          console.log('[Page HTML Capture] Skipping full-page fallback - no Q&A content found', {
            platform,
            url: window.location.href,
          })
          return
        }

        if (!isFinal) {
          return
        }

        const pageHtml = (await this.captureFullPageFromTabWithRetries()) ?? ''
        if (pageHtml.length === 0) {
          console.log('[Page HTML Capture] Final full-page capture unavailable after retries', {
            platform,
            url: window.location.href,
          })
          return
        }

        // Validate full-page capture contains Q&A structure
        let validatedHtml = pageHtml
        if (!this.isValidQACapture(pageHtml, platform)) {
          console.log('[Page HTML Capture] Full-page HTML missing Q&A markers - falling back to body')
          validatedHtml = this.getFallbackHTMLContent()
          if (!validatedHtml) {
            console.log('[Page HTML Capture] No fallback content available')
            return
          }
        }

        await this.sendFullPageCapture(platform, validatedHtml, true)
        return
      }

      const captureType = 'qa'
      const pageHtml = captureRoot.outerHTML

      // Validate container capture contains Q&A structure
      let validatedHtml = pageHtml
      if (!this.isValidQACapture(pageHtml, platform)) {
        console.log('[Page HTML Capture] Container HTML missing Q&A markers - falling back to body')
        validatedHtml = this.getFallbackHTMLContent()
        if (!validatedHtml) {
          console.log('[Page HTML Capture] No fallback content available')
          return
        }
      }

      // Deduplication: for QA captures, only dispatch if HTML has changed
      const shouldDispatch = (() => {
        if (isFinal) return true // Always dispatch final snapshots
        if (captureType !== 'qa') return true // Always dispatch full_page captures
        
        const fingerprint = this.computeHtmlFingerprint(validatedHtml)
        const lastFingerprint = this.lastDispatchedQaFingerprint.get(platform)
        if (lastFingerprint === fingerprint) {
          console.log('[Page HTML Capture] Skipping QA dispatch - HTML unchanged', {
            platform,
            fingerprint,
          })
          // Still update stability tracking even though we skip dispatch
          this.updateSourceStability(platform, captureType, validatedHtml)
          // Opportunistically attempt sources capture
          void this.captureSourcesIfPossible(platform)
          return false
        }
        
        return true
      })()

      if (!shouldDispatch) {
        return
      }

      this.captureSequence += 1

      const capture = {
        captureId: `${platform}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        platform,
        chatbot_name: platform,
        secondary_identifier: platform,
        sequence: this.captureSequence,
        url: window.location.href,
        timestamp: now,
        isFinal,
        captureType,
        pageHtmlLength: validatedHtml.length,
        pageHtml: validatedHtml,
        correlationId: this.getActiveCorrelationId(now),
      }

      // Send to service worker
      await chrome.runtime.sendMessage({
        messageType: 'pageHtmlCaptureData',
        capture,
      })

      console.log('[Page HTML Capture] Capture sent', {
        captureId: capture.captureId,
        sequence: this.captureSequence,
        platform,
        isFinal,
        captureType,
        length: validatedHtml.length,
        captureRootTag: captureRoot?.tagName ?? 'BODY',
      })

      // Track dispatched QA fingerprint for deduplication
      if (captureType === 'qa') {
        const fingerprint = this.computeHtmlFingerprint(pageHtml)
        this.lastDispatchedQaFingerprint.set(platform, fingerprint)
      }

      this.updateSourceStability(platform, captureType, pageHtml)

      // Opportunistically capture sources panel if available and conditions met.
      // Perplexity's submit-triggered capture calls this with isFinal: true
      // (see triggerQuestionSubmitCapture) to bypass the periodic-capture
      // throttle/dedup, which would otherwise also skip the !isFinal check
      // below and silently prevent Perplexity's sources click from ever
      // running. ChatGPT/Gemini keep the original !isFinal gating.
      if (!isFinal || platform === 'perplexity') {
        void this.captureSourcesIfPossible(platform)
      }
    } catch (error) {
      console.error('[Page HTML Capture] Error capturing/sending page HTML:', error)
    }
  }

  private async sendFullPageCapture(platform: string, pageHtml: string, isFinal: boolean): Promise<void> {
    if (this.captureSequence >= this.MAX_CAPTURES_PER_SESSION) {
      console.warn('[Page HTML Capture] Max captures reached for this session')
      return
    }

    this.captureSequence += 1

    const now = Date.now()
    const capture = {
      captureId: `${platform}_full_${now}_${Math.random().toString(36).slice(2, 8)}`,
      platform,
      chatbot_name: platform,
      secondary_identifier: platform,
      sequence: this.captureSequence,
      url: window.location.href,
      timestamp: now,
      isFinal,
      pageHtmlLength: pageHtml.length,
      pageHtml,
      correlationId: this.getActiveCorrelationId(now),
    }

    await chrome.runtime.sendMessage({
      messageType: 'pageHtmlCaptureData',
      capture,
    })

    console.log('[Page HTML Capture] Full-page capture sent', {
      captureId: capture.captureId,
      sequence: this.captureSequence,
      platform,
      isFinal,
      length: pageHtml.length,
    })
  }

  private isUserInactive(thresholdMs: number): boolean {
    return Date.now() - this.lastUserActivityAt >= thresholdMs
  }

  /**
   * Opportunistically captures page HTML with the sources panel visible.
   * Only clicks the toggle when: (a) the toggle button is visible in the DOM,
   * and (b) the user has been inactive for `inactivityThresholdMs`. If the
   * panel is already open (user opened it themselves) we capture immediately
   * without touching the toggle at all — zero race risk.
   */
  private async captureSourcesIfPossible(platform: string): Promise<void> {
    const sourceCaptureConfig = this.config?.platformConfigs?.[platform]?.sourceCapture
    if (!sourceCaptureConfig?.enabled || !sourceCaptureConfig.sourceToggleSelector) {
      return
    }

    // Perplexity-specific: the stability gate below requires 2+ consecutive
    // IDENTICAL QA-capture fingerprints before it will ever attempt a click --
    // a leftover requirement from the old repeating-poll design. QA capture
    // is now event-driven (once per submitted turn), so that counter can
    // never reach 2 for any single turn and the click path was permanently
    // unreachable. For Perplexity, attempt the click on every completed turn
    // instead: duplicate source links across turns are acceptable and can be
    // associated back to their originating question during post-analysis.
    // ChatGPT and Gemini keep the original stability-gated behavior.
    const isPerplexity = platform === 'perplexity'
    const stableSnapshotCount = sourceCaptureConfig.stableSnapshotCount ?? 2
    let expectedFingerprint: string | null
    if (isPerplexity) {
      expectedFingerprint = this.getSourceStabilityState(platform).lastQaFingerprint
      if (!expectedFingerprint) {
        return
      }
    } else {
      const stabilityDecision = this.shouldAttemptSourcesCapture(platform, stableSnapshotCount)
      if (!stabilityDecision.ready || !stabilityDecision.fingerprint) {
        return
      }
      expectedFingerprint = stabilityDecision.fingerprint
    }

    if (this.isSourceCaptureLocked) {
      return
    }

    if (this.captureSequence >= this.MAX_CAPTURES_PER_SESSION) {
      return
    }

    // Perplexity's sourceToggleSelector matches more than one element shape:
    // the page-level Links tab trigger (one per turn, only one active at a
    // time) AND a separate inline per-turn "sources" button that opens its
    // own scrollable dialogue. A plain querySelector (first match in
    // document order) can return either one -- confirmed live to sometimes
    // grab the inline button instead of the Links tab. Prefer whichever
    // candidate is marked active (aria-selected/aria-expanded/data-state),
    // the same structural signal already used for Perplexity's other
    // toggle-selection logic in chatbots/perplexity.ts, falling back to the
    // last DOM match (most recent turn) instead of the first.
    let toggleBtn: HTMLElement | null
    if (isPerplexity) {
      const candidates = Array.from(document.querySelectorAll(sourceCaptureConfig.sourceToggleSelector))
      const activeCandidate = candidates.find((candidate) => (
        candidate.getAttribute('aria-selected') === 'true'
        || candidate.getAttribute('data-state') === 'active'
        || candidate.getAttribute('aria-expanded') === 'true'
      ))
      toggleBtn = (activeCandidate as HTMLElement | undefined)
        ?? (candidates[candidates.length - 1] as HTMLElement | undefined)
        ?? null
    } else {
      toggleBtn = document.querySelector(sourceCaptureConfig.sourceToggleSelector) as HTMLElement | null
    }
    if (!toggleBtn) {
      return
    }

    // Require the toggle to be actually visible (sources exist on this page/turn)
    const rect = toggleBtn.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) {
      return
    }

    const inactivityThreshold = sourceCaptureConfig.inactivityThresholdMs ?? 5000

    // Panel is already open if the user opened it themselves
    const isAlreadyOpen = (
      toggleBtn.getAttribute('aria-expanded') === 'true'
      || toggleBtn.getAttribute('aria-selected') === 'true'
    )

    // Only toggle programmatically when user has been idle -- except on
    // Perplexity, where we deliberately click on every completed turn
    // regardless of active typing/mouse use, per the "capture every
    // question's sources" requirement above.
    if (!isAlreadyOpen && !isPerplexity && !this.isUserInactive(inactivityThreshold)) {
      return
    }

    this.isSourceCaptureLocked = true

    try {
      let clickedToOpen = false

      if (!isAlreadyOpen) {
        toggleBtn.click()
        clickedToOpen = true

        const panelWaitMs = sourceCaptureConfig.panelWaitMs ?? 800
        await new Promise<void>(resolve => { setTimeout(resolve, panelWaitMs) })

        // If user resumed activity while we waited, abort without forcing close.
        // Forcing a close here can race with user intent and flip the panel
        // state. Perplexity skips this check for the same reason it skips the
        // inactivity gate above -- capture on every turn takes priority.
        if (!isPerplexity && !this.isUserInactive(inactivityThreshold)) {
          return
        }

        if (isPerplexity) {
          const currentFingerprint = this.getSourceStabilityState(platform).lastQaFingerprint
          if (currentFingerprint !== expectedFingerprint) {
            return
          }
        } else {
          const recheck = this.shouldAttemptSourcesCapture(platform, stableSnapshotCount)
          if (!recheck.ready || recheck.fingerprint !== expectedFingerprint) {
            return
          }
        }

        // Verify panel appeared (optional — bail gracefully if not)
        if (sourceCaptureConfig.sourcePanelSelector) {
          const panel = document.querySelector(sourceCaptureConfig.sourcePanelSelector)
          if (!panel) {
            return
          }
        }
      }

      // Capture with sources visible
      // Sources captures are opportunistic — only meaningful with a scoped Q&A root.
      // Unlike interval captures, there is no full_page fallback here: a raw dump with
      // the source panel open is not analytically useful without the Q&A structure.
      //
      // Some platforms (e.g. ChatGPT) render the sources panel as a DOM sibling of
      // the Q&A container rather than a descendant, so the scoped container capture
      // would silently drop the panel content. panelOutsideContainer opts into
      // capturing the full document body in that case instead.
      const captureRoot = sourceCaptureConfig.panelOutsideContainer
        ? document.body
        : this.resolveCaptureRoot(platform)
      if (captureRoot) {
        const pageHtml = captureRoot.outerHTML
        this.captureSequence += 1
        const now = Date.now()

        const capture = {
          captureId: `${platform}_src_${now}_${Math.random().toString(36).slice(2, 8)}`,
          platform,
          sequence: this.captureSequence,
          url: window.location.href,
          timestamp: now,
          isFinal: false,
          captureType: 'sources',
          pageHtmlLength: pageHtml.length,
          pageHtml,
          correlationId: this.getActiveCorrelationId(now),
        }

        await chrome.runtime.sendMessage({
          messageType: 'pageHtmlCaptureData',
          capture,
        })

        console.log('[Page HTML Capture] Sources capture sent', {
          captureId: capture.captureId,
          platform,
          length: pageHtml.length,
        })

        const state = this.getSourceStabilityState(platform)
        state.lastSourcesFingerprint = expectedFingerprint
      }

      // Close panel only if we were the ones who opened it
      if (clickedToOpen) {
        if (isPerplexity) {
          // Perplexity's sources affordance is a Radix tab, not a
          // collapsible panel: re-clicking the same trigger is a no-op (an
          // already-selected tab does not deselect itself), and the
          // configured sourceCloseSelector targets a different UI pattern
          // (a collapsible sidebar) that does not exist here. Explicitly
          // switch back to the default answer tab so the participant sees
          // the answer again, not the Links tab, after every question.
          //
          // A plain document-wide query for the Answers trigger can match a
          // DIFFERENT (older) turn's trigger when more than one is present,
          // since every turn renders its own default/sources tab pair.
          // toggleBtn is the exact Links trigger just clicked to open this
          // turn's panel -- its Radix id shares a prefix with this same
          // turn's Answers trigger (e.g. "radix-_r_2c_-trigger-sources" /
          // "radix-_r_2c_-trigger-default"), so deriving from it scopes the
          // return-click to the correct turn instead of guessing.
          const toggleId = toggleBtn.getAttribute('id') || ''
          const prefixMatch = toggleId.match(/^(radix-.+?-)trigger-/)
          const defaultTabBtn = (prefixMatch
            ? document.querySelector(`[id="${prefixMatch[1]}trigger-default"]`)
            : document.querySelector('[aria-controls$="-content-default"], [id$="-trigger-default"]')
          ) as HTMLElement | null
          if (defaultTabBtn) {
            defaultTabBtn.click()
          } else {
            console.log('[Page HTML Capture] Could not find matching default answer tab to return to', {
              toggleId,
            })
          }
        } else {
          const closeSelector = sourceCaptureConfig.sourceCloseSelector
          const closeBtn = closeSelector
            ? (document.querySelector(closeSelector) as HTMLElement | null)
            : null
          if (closeBtn) {
            closeBtn.click()
          } else {
            toggleBtn.click() // re-click toggle to collapse
          }
        }
      }

    } catch (error) {
      console.error('[Page HTML Capture] Source capture error:', error)
    } finally {
      this.isSourceCaptureLocked = false
    }
  }

  private stopCapture(): void {
    this.stopPeriodicFullPageCapture()
    this.stopSubmitCaptureWatch()
    console.log('[Page HTML Capture] Capture stopped')
  }

  private handleVisibilityChange(): void {
    const platform = this.detectPlatform()
    if (!platform || !this.enabled) {
      return
    }

    if (document.hidden) {
      // Page hidden - stop the full-page fallback interval, but deliberately
      // leave a submit-triggered watch running: a response can keep
      // rendering (and its completion selector still fire) while the tab is
      // backgrounded, and losing that watch would silently drop the capture
      // for this turn until the next question is submitted.
      this.stopPeriodicFullPageCapture()
    } else if (this.isFullPageFallbackEnabled(platform)) {
      // Page visible again - re-arm the full-page fallback interval if it was
      // stopped above. startPeriodicFullPageCapture clears any prior interval
      // before setting a new one, so calling it again here is safe even if
      // it was never stopped (e.g. this is the very first visibility event).
      this.startPeriodicFullPageCapture(platform)
    }
  }

  private handleBeforeUnload(): void {
    const platform = this.detectPlatform()
    if (!platform || !this.enabled) {
      return
    }

    console.log('[Page HTML Capture] Sending final capture on page unload')
    this.stopCapture()
    void this.captureAndSend(platform, true)
  }

  /**
   * Set correlation ID to link captures with interactions
   * Typically set by the LLM interaction companion module
   */
  setCorrelationId(correlationId: string | null): void {
    this.interactionCorrelationId = correlationId
    this.interactionCorrelationSetAtMs = Date.now()
    console.log('[Page HTML Capture] Correlation ID set:', correlationId)
  }

  /**
   * Register event listeners after initialization
   */
  installListeners(): void {
    if (!this.enabled || this.listenersInstalled) {
      return
    }
    this.listenersInstalled = true

    // Visibility change
    document.addEventListener('visibilitychange', () => {
      this.handleVisibilityChange()
    }, { passive: true })

    // Page unload
    window.addEventListener('beforeunload', () => {
      this.handleBeforeUnload()
    }, { passive: true })

    // User activity tracking — gates inactivity-based source toggle
    const trackActivity = (): void => { this.lastUserActivityAt = Date.now() }
    document.addEventListener('mousemove', trackActivity, { passive: true })
    document.addEventListener('keydown', trackActivity, { passive: true })
    document.addEventListener('mousedown', trackActivity, { passive: true })
    document.addEventListener('scroll', trackActivity, { passive: true })
    document.addEventListener('touchstart', trackActivity, { passive: true })

    console.log('[Page HTML Capture] Event listeners installed')
  }
}

// One instance per application
const pageHtmlCaptureModule = new PageHtmlCaptureBrowserModule()
registerREXModule(pageHtmlCaptureModule)

export { pageHtmlCaptureModule }
