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
      captureIntervalMs: number // How often to capture (e.g., 10000 for 10s)
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
}

type SourceStabilityState = {
  lastQaFingerprint: string | null
  stableQaCount: number
  lastSourcesFingerprint: string | null
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
  private captureIntervalId: NodeJS.Timeout | null = null
  private captureSequence: number = 0
  private interactionCorrelationId: string | null = null // Link captures to interactions
  private interactionCorrelationSetAtMs: number = 0
  private lastCaptureTimestamp: number = 0
  private lastUserActivityAt: number = Date.now()
  private isSourceCaptureLocked: boolean = false
  private listenersInstalled: boolean = false
  private sourceStabilityByPlatform: Map<string, SourceStabilityState> = new Map()
  private lastDispatchedQaFingerprint: Map<string, string> = new Map() // Track sent QA snapshots to avoid duplicates
  private readonly MIN_CAPTURE_INTERVAL_MS = 5000 // Don't capture faster than 5 seconds
  private readonly MAX_CAPTURES_PER_SESSION = 1000 // Memory safety
  private readonly MAX_CORRELATION_AGE_MS = 30000 // Prevent stale join keys from leaking across turns

  constructor() {
    super()
    console.log('[Page HTML Capture] Browser module initialized')
  }

  moduleName(): string {
    return 'PageHtmlCaptureBrowserModule'
  }

  async setup(): Promise<void> {
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
      platformConfig.captureIntervalMs ?? 10000,
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

  private startCapture(): void {
    const platform = this.detectPlatform()
    if (!platform) {
      console.log('[Page HTML Capture] Not on a supported platform')
      return
    }

    const { enabled, intervalMs } = this.isPlatformEnabled(platform)
    if (!enabled) {
      console.log('[Page HTML Capture] Platform not enabled:', platform)
      return
    }

    console.log('[Page HTML Capture] Starting periodic capture on', platform, 'interval:', intervalMs)

    // Capture immediately
    this.captureAndSend(platform, false)

    // Then periodically
    this.captureIntervalId = setInterval(() => {
      this.captureAndSend(platform, false)
    }, intervalMs)
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

      const captureType = captureRoot ? 'qa' : 'full_page'
      const pageHtml = captureRoot
        ? captureRoot.outerHTML
        : (document.body ?? document.documentElement).outerHTML

      if (!captureRoot) {
        console.log('[Page HTML Capture] Q&A selectors not resolved, capturing full page via fallback toggle', {
          platform,
          url: window.location.href,
        })
      }

      // Deduplication: for QA captures, only dispatch if HTML has changed
      const shouldDispatch = (() => {
        if (isFinal) return true // Always dispatch final snapshots
        if (captureType !== 'qa') return true // Always dispatch full_page captures
        
        const fingerprint = this.computeHtmlFingerprint(pageHtml)
        const lastFingerprint = this.lastDispatchedQaFingerprint.get(platform)
        if (lastFingerprint === fingerprint) {
          console.log('[Page HTML Capture] Skipping QA dispatch - HTML unchanged', {
            platform,
            fingerprint,
          })
          // Still update stability tracking even though we skip dispatch
          this.updateSourceStability(platform, captureType, pageHtml)
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
        sequence: this.captureSequence,
        url: window.location.href,
        timestamp: now,
        isFinal,
        captureType,
        pageHtmlLength: pageHtml.length,
        pageHtml,
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
        length: pageHtml.length,
        captureRootTag: captureRoot?.tagName ?? 'BODY',
      })

      // Track dispatched QA fingerprint for deduplication
      if (captureType === 'qa') {
        const fingerprint = this.computeHtmlFingerprint(pageHtml)
        this.lastDispatchedQaFingerprint.set(platform, fingerprint)
      }

      this.updateSourceStability(platform, captureType, pageHtml)

      // Opportunistically capture sources panel if available and conditions met
      if (!isFinal) {
        void this.captureSourcesIfPossible(platform)
      }
    } catch (error) {
      console.error('[Page HTML Capture] Error capturing/sending page HTML:', error)
    }
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

    const stableSnapshotCount = sourceCaptureConfig.stableSnapshotCount ?? 2
    const stabilityDecision = this.shouldAttemptSourcesCapture(platform, stableSnapshotCount)
    if (!stabilityDecision.ready || !stabilityDecision.fingerprint) {
      return
    }

    if (this.isSourceCaptureLocked) {
      return
    }

    if (this.captureSequence >= this.MAX_CAPTURES_PER_SESSION) {
      return
    }

    const toggleBtn = document.querySelector(sourceCaptureConfig.sourceToggleSelector) as HTMLElement | null
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

    // Only toggle programmatically when user has been idle
    if (!isAlreadyOpen && !this.isUserInactive(inactivityThreshold)) {
      return
    }

    this.isSourceCaptureLocked = true

    try {
      let clickedToOpen = false
      const expectedFingerprint = stabilityDecision.fingerprint

      if (!isAlreadyOpen) {
        toggleBtn.click()
        clickedToOpen = true

        const panelWaitMs = sourceCaptureConfig.panelWaitMs ?? 800
        await new Promise<void>(resolve => { setTimeout(resolve, panelWaitMs) })

        // If user resumed activity while we waited, abort without forcing close.
        // Forcing a close here can race with user intent and flip the panel state.
        if (!this.isUserInactive(inactivityThreshold)) {
          return
        }

        const recheck = this.shouldAttemptSourcesCapture(platform, stableSnapshotCount)
        if (!recheck.ready || recheck.fingerprint !== expectedFingerprint) {
          return
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
      const captureRoot = this.resolveCaptureRoot(platform)
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

    } catch (error) {
      console.error('[Page HTML Capture] Source capture error:', error)
    } finally {
      this.isSourceCaptureLocked = false
    }
  }

  private stopCapture(): void {
    if (this.captureIntervalId !== null) {
      clearInterval(this.captureIntervalId)
      this.captureIntervalId = null
      console.log('[Page HTML Capture] Capture stopped')
    }
  }

  private handleVisibilityChange(): void {
    const platform = this.detectPlatform()
    if (!platform || !this.enabled) {
      return
    }

    if (document.hidden) {
      // Page hidden - stop capture
      this.stopCapture()
    } else {
      // Page visible - resume capture if not already running
      if (this.captureIntervalId === null) {
        this.startCapture()
      }
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
