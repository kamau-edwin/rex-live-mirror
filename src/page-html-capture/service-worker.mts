import { REXServiceWorkerModule, registerREXModule, dispatchEvent } from '@bric/rex-core/service-worker'

/**
 * Page HTML Capture Service Worker Module
 *
 * Receives page HTML captures from the browser module, maintains:
 * - In-memory capture storage by URL / correlation ID
 * - Cleanup of stale captures
 *
 * and is the sole owner of dispatching chatbot-html-snapshot events to PDK
 * (mirrors the pattern used by rex-web-visits: capture, dedup, and dispatch
 * all live in this one module via the shared dispatchEvent bus).
 */

export interface PageHtmlCapture {
  captureId: string
  platform: string
  chatbot_name?: string
  secondary_identifier?: string
  sequence: number
  url: string
  timestamp: number
  isFinal: boolean
  captureType?: string
  pageHtmlLength: number
  pageHtml: string
  correlationId?: string | null
  source?: string
  generatorId?: string
}

export interface PageHtmlCaptureStorageConfig {
  enabled?: boolean
  maxCapturesPerUrl?: number
  maxCaptureSizeBytes?: number
  staleCaptureThresholdMs?: number
}

interface DedupState {
  lastEmittedAtMs: number
  lastFingerprintByIdentifier: Map<string, string>
}

const DEFAULT_DEDUP_WINDOW_MS = 15000
const DEFAULT_SNIPPET_MAX_LENGTH = 200000
const FALLBACK_HOSTS_BY_PLATFORM: Record<string, string[]> = {
  perplexity: ['www.perplexity.ai', 'perplexity.ai'],
  chatgpt: ['chatgpt.com'],
  gemini: ['gemini.google.com'],
  claude: ['claude.ai'],
}

function coerceBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true') return true
    if (normalized === 'false') return false
  }
  return null
}

function normalizeChatbotIdentifier(candidate: unknown): string | null {
  if (typeof candidate !== 'string') {
    return null
  }
  const normalized = candidate.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '')
  return normalized.length > 0 ? normalized : null
}

function resolveChatbotIdentifierFromUrl(
  url: string,
  configuration: any, // eslint-disable-line @typescript-eslint/no-explicit-any
): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase()
    const platforms = configuration?.llm_capture?.platforms

    if (platforms && typeof platforms === 'object') {
      for (const [platformName, platformConfig] of Object.entries(platforms as Record<string, unknown>)) {
        if (!platformConfig || typeof platformConfig !== 'object') {
          continue
        }

        const enabled = coerceBoolean((platformConfig as { enabled?: unknown }).enabled)
        if (enabled === false) {
          continue
        }

        const hosts = (platformConfig as { hosts?: unknown }).hosts
        if (!Array.isArray(hosts)) {
          continue
        }

        for (const candidateHost of hosts) {
          if (typeof candidateHost !== 'string') {
            continue
          }
          const normalizedCandidate = candidateHost.toLowerCase()
          if (host === normalizedCandidate || host.endsWith(`.${normalizedCandidate}`)) {
            return normalizeChatbotIdentifier(platformName)
          }
        }
      }
    }

    // Resilient fallback when backend platform host config is unavailable/incomplete.
    for (const [platformName, candidateHosts] of Object.entries(FALLBACK_HOSTS_BY_PLATFORM)) {
      for (const candidateHost of candidateHosts) {
        const normalizedCandidate = candidateHost.toLowerCase()
        if (host === normalizedCandidate || host.endsWith(`.${normalizedCandidate}`)) {
          return normalizeChatbotIdentifier(platformName)
        }
      }
    }
  } catch {
    // Ignore parse failures.
  }

  return null
}

function shouldDispatchCapture(
  url: string,
  configuration: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  options: { captureType?: string, platform?: string | null },
): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()

    const blockedHosts = configuration?.llm_capture?.blocked_hosts
    if (Array.isArray(blockedHosts) && blockedHosts.includes(host)) {
      return false
    }

    const platforms = configuration?.llm_capture?.platforms
    if (!platforms || typeof platforms !== 'object') {
      return false
    }

    const normalizedPlatform = normalizeChatbotIdentifier(options.platform)
    if (options.captureType === 'full_page' && normalizedPlatform) {
      const platformConfig = (platforms as Record<string, unknown>)[normalizedPlatform] as { enabled?: unknown } | undefined
      if (platformConfig && coerceBoolean(platformConfig.enabled) !== false) {
        return true
      }
    }

    for (const value of Object.values(platforms as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') {
        continue
      }
      if (coerceBoolean((value as { enabled?: unknown }).enabled) === false) {
        continue
      }
      const hosts = (value as { hosts?: unknown }).hosts
      if (!Array.isArray(hosts)) {
        continue
      }
      for (const candidateHost of hosts) {
        if (typeof candidateHost !== 'string') {
          continue
        }
        const normalizedCandidate = candidateHost.toLowerCase()
        if (host === normalizedCandidate || host.endsWith(`.${normalizedCandidate}`)) {
          return true
        }
      }
    }
  } catch {
    return false
  }

  return false
}

function resolveSnippetLimit(configuration: any): number | null { // eslint-disable-line @typescript-eslint/no-explicit-any
  const configured = configuration?.page_html_capture?.bridge?.maxSnippetLength

  if (configured === null) {
    return null
  }

  if (typeof configured === 'number' && Number.isFinite(configured)) {
    return configured <= 0 ? null : Math.floor(configured)
  }

  if (typeof configured === 'string') {
    const parsed = Number(configured)
    if (Number.isFinite(parsed)) {
      return parsed <= 0 ? null : Math.floor(parsed)
    }
  }

  return DEFAULT_SNIPPET_MAX_LENGTH
}

function resolveDedupWindowMs(configuration: any): number { // eslint-disable-line @typescript-eslint/no-explicit-any
  const configured = configuration?.extension?.telemetry?.chatbot_html_snapshot_dedup_window_ms
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured)
  }
  return DEFAULT_DEDUP_WINDOW_MS
}

function resolveSnapshotEventName(configuration: any): string { // eslint-disable-line @typescript-eslint/no-explicit-any
  const configured = configuration?.extension?.telemetry?.event_names?.chatbot_html_snapshot
  return typeof configured === 'string' && configured.trim().length > 0
    ? configured.trim()
    : 'chatbot-html-snapshot'
}

class PageHtmlCaptureServiceWorkerModule extends REXServiceWorkerModule {
  private enabled: boolean = false
  private config: PageHtmlCaptureStorageConfig | null = null
  private capturesByUrl = new Map<string, PageHtmlCapture[]>()
  private capturesByCorrelationId = new Map<string, PageHtmlCapture[]>()
  private readonly DEFAULT_MAX_CAPTURES_PER_URL = 100
  private readonly DEFAULT_STALE_THRESHOLD_MS = 60 * 60 * 1000 // 1 hour
  private cleanupIntervalId: NodeJS.Timeout | null = null
  private dedupState: DedupState = { lastEmittedAtMs: 0, lastFingerprintByIdentifier: new Map() }
  private appConfiguration: any = null // eslint-disable-line @typescript-eslint/no-explicit-any

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

    this.loadConfiguration()

    this.cleanupIntervalId = setInterval(() => {
      this.pruneStaleCaptures()
    }, 5 * 60 * 1000)

    console.log('[Page HTML Capture] Service Worker module ready')
  }

  refreshConfiguration(): void {
    this.loadConfiguration()
  }

  private loadConfiguration(): void {
    chrome.storage.local.get('REXConfiguration', (result) => {
      const configuration = result?.REXConfiguration
      if (configuration) {
        this.appConfiguration = configuration
      }
    })
  }

  handleMessage(message: any, sender: any, sendResponse: (response: any) => void): boolean { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (message?.messageType === 'pageHtmlCaptureData') {
      const capture = message.capture as PageHtmlCapture

      if (!capture?.pageHtml || typeof capture.pageHtml !== 'string') {
        sendResponse({ success: false, error: 'invalid-capture-data' })
        return true
      }

      this.storeCapture(capture)
      void this.dispatchCapture(capture)
      sendResponse({ success: true })

      return true
    } else if (message?.messageType === 'getPageHtmlCaptures') {
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
    const capturesByUrl = this.capturesByUrl.get(capture.url) ?? []
    capturesByUrl.push(capture)

    const maxCapturesPerUrl = this.config?.maxCapturesPerUrl ?? this.DEFAULT_MAX_CAPTURES_PER_URL
    if (capturesByUrl.length > maxCapturesPerUrl) {
      const removed = capturesByUrl.shift()
      console.log('[Page HTML Capture] Removed oldest capture for URL (max reached)', {
        removedId: removed?.captureId,
        urlSize: capturesByUrl.length,
      })
    }

    this.capturesByUrl.set(capture.url, capturesByUrl)

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
      chatbot_name: capture.chatbot_name ?? capture.platform,
      secondary_identifier: capture.secondary_identifier ?? capture.chatbot_name ?? capture.platform,
      sequence: capture.sequence,
      isFinal: capture.isFinal,
      url: capture.url,
      correlationId: capture.correlationId ?? 'none',
      size: capture.pageHtmlLength,
    })
  }

  private shouldEmit(secondaryIdentifier: string, url: string, htmlSnippet: string, captureType: string | null, dedupWindowMs: number): boolean {
    const now = Date.now()
    const normalizedUrl = url.split('#', 1)[0].split('?', 1)[0]
    const normalizedSnippet = htmlSnippet.trim()
    const fingerprint = [
      secondaryIdentifier,
      normalizedUrl,
      captureType ?? 'unspecified',
      String(normalizedSnippet.length),
      normalizedSnippet.slice(0, 512),
    ].join('|')

    const lastFingerprint = this.dedupState.lastFingerprintByIdentifier.get(secondaryIdentifier)
    const withinWindow = (now - this.dedupState.lastEmittedAtMs) < dedupWindowMs

    if (withinWindow && lastFingerprint === fingerprint) {
      return false
    }

    this.dedupState.lastEmittedAtMs = now
    this.dedupState.lastFingerprintByIdentifier.set(secondaryIdentifier, fingerprint)
    return true
  }

  private async dispatchCapture(capture: PageHtmlCapture): Promise<void> {
    const captureUrl = typeof capture.url === 'string' ? capture.url : null
    const captureHtml = typeof capture.pageHtml === 'string' ? capture.pageHtml : ''

    if (!captureUrl || captureHtml.length === 0) {
      return
    }

    const configuration = this.appConfiguration
    const captureType = typeof capture.captureType === 'string' ? capture.captureType : 'qa'

    if (!shouldDispatchCapture(captureUrl, configuration, { captureType, platform: capture.platform ?? null })) {
      return
    }

    const snippetLimit = resolveSnippetLimit(configuration)
    const snippet = snippetLimit === null ? captureHtml : captureHtml.slice(0, snippetLimit)
    const secondaryIdentifier = normalizeChatbotIdentifier(capture.platform)
      ?? resolveChatbotIdentifierFromUrl(captureUrl, configuration)
      ?? 'unknown'

    const dedupWindowMs = resolveDedupWindowMs(configuration)
    if (!this.shouldEmit(secondaryIdentifier, captureUrl, snippet, captureType, dedupWindowMs)) {
      console.log('[Page HTML Capture] Dispatch skipped (dedup window).', {
        secondaryIdentifier,
        captureType,
        url: captureUrl,
      })
      return
    }

    dispatchEvent({
      name: 'chatbot-html-snapshot',
      event_name: resolveSnapshotEventName(configuration),
      generatorId: capture.generatorId ?? 'chatbot-html-snapshot',
      secondary_identifier: secondaryIdentifier,
      chatbot_name: secondaryIdentifier,
      source: capture.source ?? 'page_html_capture',
      capture_id: capture.captureId ?? null,
      capture_sequence: typeof capture.sequence === 'number' ? capture.sequence : null,
      platform: capture.platform ?? null,
      correlation_id: capture.correlationId ?? null,
      snapshot: {
        url: captureUrl,
        captured_at_ms: typeof capture.timestamp === 'number' ? capture.timestamp : Date.now(),
        html_length: typeof capture.pageHtmlLength === 'number' ? capture.pageHtmlLength : captureHtml.length,
        html_snippet: snippet,
        html_snippet_limit: snippetLimit,
        html_snippet_truncated: snippet.length < captureHtml.length,
        capture_type: captureType,
        correlation_id: capture.correlationId ?? null,
        is_final: capture.isFinal === true,
        title: null,
      },
    })

    console.log('[Page HTML Capture] Dispatched chatbot-html-snapshot.', {
      secondaryIdentifier,
      captureType,
      captureId: capture.captureId,
      url: captureUrl,
    })
  }

  private getCapturesByUrl(url: string): PageHtmlCapture[] {
    const captures = this.capturesByUrl.get(url) ?? []
    return captures.map(c => ({
      ...c,
      pageHtml: '',
    }))
  }

  private getCapturesByCorrelationId(correlationId: string): PageHtmlCapture[] {
    const captures = this.capturesByCorrelationId.get(correlationId) ?? []
    return captures.map(c => ({
      ...c,
      pageHtml: '',
    }))
  }

  private pruneStaleCaptures(): void {
    const staleThreshold = this.config?.staleCaptureThresholdMs ?? this.DEFAULT_STALE_THRESHOLD_MS
    const now = Date.now()
    const urlsToDelete: string[] = []
    const correlationIdsToDelete: string[] = []

    for (const [url, captures] of this.capturesByUrl.entries()) {
      const validCaptures = captures.filter(c => (now - c.timestamp) < staleThreshold)

      if (validCaptures.length === 0) {
        urlsToDelete.push(url)
      } else if (validCaptures.length < captures.length) {
        this.capturesByUrl.set(url, validCaptures)
      }
    }

    for (const [correlationId, captures] of this.capturesByCorrelationId.entries()) {
      const validCaptures = captures.filter(c => (now - c.timestamp) < staleThreshold)

      if (validCaptures.length === 0) {
        correlationIdsToDelete.push(correlationId)
      } else if (validCaptures.length < captures.length) {
        this.capturesByCorrelationId.set(correlationId, validCaptures)
      }
    }

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

  dispose(): void {
    if (this.cleanupIntervalId !== null) {
      clearInterval(this.cleanupIntervalId)
    }
    this.capturesByUrl.clear()
    this.capturesByCorrelationId.clear()
  }
}

const pageHtmlCaptureModule = new PageHtmlCaptureServiceWorkerModule({ enabled: true })
registerREXModule(pageHtmlCaptureModule)

export { pageHtmlCaptureModule }
