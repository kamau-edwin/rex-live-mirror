import { REXServiceWorkerModule, registerREXModule, dispatchEvent } from '@bric/rex-core/service-worker'

/**
 * Page HTML Capture Service Worker Module
 * 
 * Receives page HTML captures from browser module and maintains:
 * - In-memory capture storage by URL
 * - Correlation linkage between captures and interactions
 * - Cleanup of stale captures
 * 
 * Provides storage hooks for dependent modules (e.g., news_eval)
 * to integrate captures into their pipelines.
 */

export interface PageHtmlCapture {
  captureId: string
  platform: string
  sequence: number
  url: string
  timestamp: number
  isFinal: boolean
  pageHtmlLength: number
  pageHtml: string
  correlationId?: string | null
}

export interface PageHtmlCaptureStorageConfig {
  enabled?: boolean
  maxCapturesPerUrl?: number
  maxCaptureSizeBytes?: number
  staleCaptureThresholdMs?: number
}

class PageHtmlCaptureServiceWorkerModule extends REXServiceWorkerModule {
  private enabled: boolean = false
  private config: PageHtmlCaptureStorageConfig | null = null
  private capturesByUrl = new Map<string, PageHtmlCapture[]>()
  private capturesByCorrelationId = new Map<string, PageHtmlCapture[]>()
  private readonly DEFAULT_MAX_CAPTURES_PER_URL = 100
  private readonly DEFAULT_MAX_CAPTURE_SIZE_BYTES = 5 * 1024 * 1024 // 5 MB
  private readonly DEFAULT_STALE_THRESHOLD_MS = 60 * 60 * 1000 // 1 hour
  private cleanupIntervalId: NodeJS.Timeout | null = null

  constructor(config?: PageHtmlCaptureStorageConfig) {
    super()
    if (config?.enabled === true) {
      this.enabled = true
      this.config = config
    }
  }

  moduleName(): string {
    return 'PageHtmlCaptureServiceWorkerModule'
  }

  setup(): void {
    console.log('[Page HTML Capture] Service Worker module initializing')

    if (!this.enabled) {
      console.log('[Page HTML Capture] Module disabled')
      return
    }

    // Start cleanup interval (every 5 minutes)
    this.cleanupIntervalId = setInterval(() => {
      this.pruneStaleCaptures()
    }, 5 * 60 * 1000)

    console.log('[Page HTML Capture] Service Worker module ready')
  }

  handleMessage(message: any, sender: any, sendResponse: (response: any) => void): boolean { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (message?.messageType === 'pageHtmlCaptureData') {
      const capture = message.capture as PageHtmlCapture

      if (!capture?.pageHtml || typeof capture.pageHtml !== 'string') {
        sendResponse({ success: false, error: 'invalid-capture-data' })
        return true
      }

      this.storeCapture(capture)
      sendResponse({ success: true })

      return true
    } else if (message?.messageType === 'getPageHtmlCaptures') {
      // Query captures by URL or correlation ID
      const url = message.url as string | undefined
      const correlationId = message.correlationId as string | undefined

      if (url) {
        const captures = this.getCapturesByUrl(url)
        sendResponse({ success: true, captures })
      } else if (correlationId) {
        const captures = this.getCapturesByCorrelationId(correlationId)
        sendResponse({ success: true, captures })
      } else {
        sendResponse({ success: false, error: 'url-or-correlation-id-required' })
      }

      return true
    } else if (message?.messageType === 'clearPageHtmlCaptures') {
      // Clear captures for a specific URL or correlation ID
      const url = message.url as string | undefined
      const correlationId = message.correlationId as string | undefined

      if (url) {
        this.capturesByUrl.delete(url)
      } else if (correlationId) {
        this.capturesByCorrelationId.delete(correlationId)
      }

      sendResponse({ success: true })
      return true
    }

    return false
  }

  private storeCapture(capture: PageHtmlCapture): void {
    // Store by URL
    const capturesByUrl = this.capturesByUrl.get(capture.url) ?? []
    capturesByUrl.push(capture)

    // Enforce max captures per URL
    const maxCapturesPerUrl = this.config?.maxCapturesPerUrl ?? this.DEFAULT_MAX_CAPTURES_PER_URL
    if (capturesByUrl.length > maxCapturesPerUrl) {
      const removed = capturesByUrl.shift()
      console.log('[Page HTML Capture] Removed oldest capture for URL (max reached)', {
        removedId: removed?.captureId,
        urlSize: capturesByUrl.length,
      })
    }

    this.capturesByUrl.set(capture.url, capturesByUrl)

    // Store by correlation ID if provided
    if (capture.correlationId) {
      const capturesByCorrelation = this.capturesByCorrelationId.get(capture.correlationId) ?? []
      capturesByCorrelation.push(capture)

      const maxCaptures = this.config?.maxCapturesPerUrl ?? this.DEFAULT_MAX_CAPTURES_PER_URL
      if (capturesByCorrelation.length > maxCaptures) {
        capturesByCorrelation.shift()
      }

      this.capturesByCorrelationId.set(capture.correlationId, capturesByCorrelation)
    }

    console.log('[Page HTML Capture] Capture stored', {
      captureId: capture.captureId,
      platform: capture.platform,
      sequence: capture.sequence,
      isFinal: capture.isFinal,
      url: capture.url,
      correlationId: capture.correlationId ?? 'none',
      size: capture.pageHtmlLength,
    })

    // Emit event for analytics/monitoring
    if (capture.isFinal) {
      void dispatchEvent({
        name: 'pdk-app-event',
        event_name: 'page_html_capture_final',
        generatorId: 'page-html-capture',
        platform: capture.platform,
        captureSequence: capture.sequence,
        finalHtmlLength: capture.pageHtmlLength,
        url: capture.url,
      })
    }
  }

  private getCapturesByUrl(url: string): PageHtmlCapture[] {
    const captures = this.capturesByUrl.get(url) ?? []
    // Return copies without raw HTML to reduce message size
    return captures.map(c => ({
      ...c,
      pageHtml: '', // Clear HTML from response; fetch separately if needed
    }))
  }

  private getCapturesByCorrelationId(correlationId: string): PageHtmlCapture[] {
    const captures = this.capturesByCorrelationId.get(correlationId) ?? []
    return captures.map(c => ({
      ...c,
      pageHtml: '', // Clear HTML from response; fetch separately if needed
    }))
  }

  private pruneStaleCaptures(): void {
    const staleThreshold = this.config?.staleCaptureThresholdMs ?? this.DEFAULT_STALE_THRESHOLD_MS
    const now = Date.now()
    const urlsToDelete: string[] = []
    const correlationIdsToDelete: string[] = []

    // Prune by URL
    for (const [url, captures] of this.capturesByUrl.entries()) {
      const validCaptures = captures.filter(c => (now - c.timestamp) < staleThreshold)

      if (validCaptures.length === 0) {
        urlsToDelete.push(url)
      } else if (validCaptures.length < captures.length) {
        this.capturesByUrl.set(url, validCaptures)
      }
    }

    // Prune by correlation ID
    for (const [correlationId, captures] of this.capturesByCorrelationId.entries()) {
      const validCaptures = captures.filter(c => (now - c.timestamp) < staleThreshold)

      if (validCaptures.length === 0) {
        correlationIdsToDelete.push(correlationId)
      } else if (validCaptures.length < captures.length) {
        this.capturesByCorrelationId.set(correlationId, validCaptures)
      }
    }

    // Delete empty entries
    for (const url of urlsToDelete) {
      this.capturesByUrl.delete(url)
    }
    for (const correlationId of correlationIdsToDelete) {
      this.capturesByCorrelationId.delete(correlationId)
    }

    if (urlsToDelete.length > 0 || correlationIdsToDelete.length > 0) {
      console.log('[Page HTML Capture] Pruned stale captures', {
        staleCapturesRemoved: urlsToDelete.length + correlationIdsToDelete.length,
      })
    }
  }

  /**
   * Get capture HTML for a specific captureId (full content)
   * Used when dependent modules need the actual HTML, not just metadata
   */
  getCaptureHtmlById(captureId: string): string | null {
    for (const captures of this.capturesByUrl.values()) {
      const capture = captures.find(c => c.captureId === captureId)
      if (capture) {
        return capture.pageHtml
      }
    }

    for (const captures of this.capturesByCorrelationId.values()) {
      const capture = captures.find(c => c.captureId === captureId)
      if (capture) {
        return capture.pageHtml
      }
    }

    return null
  }

  override dispose(): void {
    if (this.cleanupIntervalId !== null) {
      clearInterval(this.cleanupIntervalId)
    }
    this.capturesByUrl.clear()
    this.capturesByCorrelationId.clear()
    super.dispose()
  }
}

const pageHtmlCaptureModule = new PageHtmlCaptureServiceWorkerModule({ enabled: true })
registerREXModule(pageHtmlCaptureModule)

export { pageHtmlCaptureModule }
