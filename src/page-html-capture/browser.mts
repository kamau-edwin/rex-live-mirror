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
  platformConfigs?: {
    [platform: string]: {
      enabled: boolean
      captureIntervalMs: number // How often to capture (e.g., 10000 for 10s)
    }
  }
}

class PageHtmlCaptureBrowserModule extends REXClientModule {
  private enabled: boolean = false
  private config: PageHtmlCaptureConfig | null = null
  private captureIntervalId: NodeJS.Timeout | null = null
  private captureSequence: number = 0
  private interactionCorrelationId: string | null = null // Link captures to interactions
  private lastCaptureTimestamp: number = 0
  private readonly MIN_CAPTURE_INTERVAL_MS = 5000 // Don't capture faster than 5 seconds
  private readonly MAX_CAPTURES_PER_SESSION = 1000 // Memory safety

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

  private detectPlatform(): string | null {
    const hostname = window.location.hostname
    if (hostname.includes('chatgpt.com')) return 'chatgpt'
    if (hostname.includes('claude.ai')) return 'claude'
    if (hostname.includes('perplexity.ai')) return 'perplexity'
    if (hostname.includes('gemini.google.com')) return 'gemini'
    if (hostname.includes('copilot.microsoft.com')) return 'copilot'
    return null
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
      const pageHtml = document.documentElement.outerHTML
      this.captureSequence += 1

      const capture = {
        captureId: `${platform}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        platform,
        sequence: this.captureSequence,
        url: window.location.href,
        timestamp: now,
        isFinal,
        pageHtmlLength: pageHtml.length,
        pageHtml,
        correlationId: this.interactionCorrelationId,
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
        length: pageHtml.length,
      })
    } catch (error) {
      console.error('[Page HTML Capture] Error capturing/sending page HTML:', error)
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
    console.log('[Page HTML Capture] Correlation ID set:', correlationId)
  }

  /**
   * Register event listeners after initialization
   */
  installListeners(): void {
    if (!this.enabled) {
      return
    }

    // Visibility change
    document.addEventListener('visibilitychange', () => {
      this.handleVisibilityChange()
    }, { passive: true })

    // Page unload
    window.addEventListener('beforeunload', () => {
      this.handleBeforeUnload()
    }, { passive: true })

    console.log('[Page HTML Capture] Event listeners installed')
  }
}

// One instance per application
const pageHtmlCaptureModule = new PageHtmlCaptureBrowserModule()
registerREXModule(pageHtmlCaptureModule)

export { pageHtmlCaptureModule }
