import { matchDomainAgainstList } from '@bric/rex-lists'

/**
 * Service-worker check applied to every chatbot record before dispatch.
 *
 * Content scripts read the configuration once, when the page loads, so a
 * chatbot tab opened before the participant turned that chatbot off (or
 * blocked its site) would otherwise keep capturing. The configuration is
 * read fresh from storage on every call, which also avoids the race where a
 * newly woken service worker handles a message before setup() has loaded
 * its configuration.
 */

type JsonObject = { [key: string]: any } // eslint-disable-line @typescript-eslint/no-explicit-any

async function loadLlmCaptureConfig(): Promise<JsonObject | null> {
  const stored = await chrome.storage.local.get('REXConfiguration')
  const llmCapture = (stored?.REXConfiguration as JsonObject | undefined)?.llm_capture

  return llmCapture !== null && typeof llmCapture === 'object' ? llmCapture : null
}

function normalizeSource(source: unknown): string {
  return typeof source === 'string' ? source.trim().toLowerCase() : ''
}

/** True if any blocklist named in llm_capture.blocklist_lists matches the URL. */
async function isBlocked(url: unknown, blocklists: unknown): Promise<boolean> {
  if (!Array.isArray(blocklists) || blocklists.length === 0) {
    return false
  }

  // Without a URL the record can't be checked against a blocklist; refuse it.
  if (typeof url !== 'string' || url.length === 0) {
    return true
  }

  for (const listName of blocklists) {
    if (typeof listName !== 'string') {
      continue
    }

    try {
      if (await matchDomainAgainstList(url, listName) !== null) {
        return true
      }
    } catch {
      // Fail closed: an unreadable blocklist must not let a record through.
      return true
    }
  }

  return false
}

export async function isCaptureAllowed(source: unknown, url: unknown): Promise<boolean> {
  const config = await loadLlmCaptureConfig()

  if (config === null || config.enabled !== true) {
    return false
  }

  const name = normalizeSource(source)
  const sources = Array.isArray(config.sources) ? config.sources.map(normalizeSource) : []

  if (name.length === 0 || !sources.includes(name)) {
    return false
  }

  const platform = config.platforms?.[name]

  if (platform !== null && typeof platform === 'object' && platform.enabled === false) {
    return false
  }

  return !(await isBlocked(url, config.blocklist_lists))
}

/** Historical-chat sync and background-tab capture reach beyond live use; opt-in only. */
export async function isHistoricalSyncAllowed(): Promise<boolean> {
  const config = await loadLlmCaptureConfig()

  return config?.allow_historical_sync === true
}
