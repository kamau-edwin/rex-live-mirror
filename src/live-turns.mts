/**
 * Live-only capture: telling past turns on a chatbot page from new ones.
 *
 * The browser module reads every turn on the page. Opening an existing
 * conversation, or scrolling up so older turns load, puts past turns on the
 * page that were asked before the participant joined (or on earlier days).
 * Unless llm_capture.allow_historical_sync is on, those turns are skipped:
 *
 * - A conversation is live once the participant submits a question in it, or
 *   when it was started on a new-chat page in this tab. A conversation opened
 *   as it already was (a page load on its URL, or switching to it from
 *   another conversation) is not live, so every turn on the page is past.
 * - In a live conversation, new turns are added below the ones already seen.
 *   A turn not seen before that sits above a seen one was loaded by
 *   scrolling up, so it is past too.
 */

export type PageTurn = { type: 'question' | 'response', content: string }

function prefix(content: string, length: number): string {
  return content.trim().substring(0, length).replace(/\s+/g, ' ')
}

/**
 * A key per turn, stable across page scans: the turn's opening text, a
 * response's question, and how many identical turns precede it (the same
 * question asked twice, or two answers with the same opening).
 */
export function turnKeys(turns: PageTurn[], prefixLength = 100): string[] {
  const occurrences = new Map<string, number>()
  let question = ''

  return turns.map((turn) => {
    const text = prefix(turn.content, prefixLength)
    const base = turn.type === 'question' ? `question:${text}` : `response:${question}:${text}`

    if (turn.type === 'question') {
      question = text
    }

    const count = (occurrences.get(base) || 0) + 1
    occurrences.set(base, count)

    return `${base}#${count}`
  })
}

/** Indexes of the turns that are past history (see the module comment). */
export function pastTurnIndexes(keys: string[], isKnown: (key: string) => boolean, live: boolean): Set<number> {
  let lastKnown = -1

  keys.forEach((key, index) => {
    if (isKnown(key)) {
      lastKnown = index
    }
  })

  const past = new Set<number>()

  keys.forEach((key, index) => {
    if (!isKnown(key) && (!live || index < lastKnown)) {
      past.add(index)
    }
  })

  return past
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

function firstGroup(path: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = path.match(pattern)

    if (match) {
      return match[1]
    }
  }

  return null
}

/**
 * The conversation a path shows, or null for a new-chat page (or any other
 * page). The same conversation can move to another path (Perplexity's
 * /search/new/<id> becoming /search/<id>, a ChatGPT chat moved to another
 * project): the key stays the same. Hosts not listed return null, which keeps
 * every turn (the previous behaviour).
 */
export function conversationKey(host: string, path: string): string | null {
  if (/(^|\.)chatgpt\.com$/.test(host)) {
    // /c/<id>, also inside custom GPTs and projects (/g/<gpt>/c/<id>); shared chats.
    const id = firstGroup(path, [/\/c\/([0-9a-f-]{8,})(?:\/|$)/i, /^\/share\/([^/]+)/])
    return id && `chatgpt:${id.toLowerCase()}`
  }

  if (/(^|\.)gemini\.google\.com$/.test(host)) {
    // /app/<id> or /u/<n>/app/<id>; a Gem's conversation /gem/<gem>/<id>.
    const id = firstGroup(path, [/\/app\/([0-9a-f]{8,})(?:\/|$)/i, /\/gem\/[^/]+\/([0-9a-f]{8,})(?:\/|$)/i])
    return id && `gemini:${id.toLowerCase()}`
  }

  if (/(^|\.)perplexity\.ai$/.test(host)) {
    // Threads: /search/<id>, /search/new/<id>, /search/<slug>-<id>,
    // /session/<id>; agent tasks: /computer/tasks/<id>.
    const segment = firstGroup(path, [
      /^\/search\/new\/([^/]+)/,
      /^\/search\/(?!new\/?$)([^/]+)/,
      /^\/session\/([^/]+)/,
      /^\/computer\/tasks\/([^/]+)/,
    ])

    if (!segment) {
      return null
    }

    const id = segment.match(UUID)?.[0] ?? segment.match(/-([A-Za-z0-9_.]{15,30})$/)?.[1] ?? segment
    return `perplexity:${id.toLowerCase()}`
  }

  if (/(^|\.)claude\.ai$/.test(host)) {
    const id = firstGroup(path, [/^\/chat\/([0-9a-f-]{8,})(?:\/|$)/i])
    return id && `claude:${id.toLowerCase()}`
  }

  return null
}

/** Whether a path is an existing conversation, as opposed to a new-chat page. */
export function isConversationPath(host: string, path: string): boolean {
  return conversationKey(host, path) !== null
}

/**
 * What a scan's URL means for whether the conversation on the page is live:
 *
 * - 'same': the path hasn't changed.
 * - 'moved': the same conversation at another URL, or a new chat with
 *   messages whose URL changed before it got its conversation URL. The
 *   conversation's state carries over.
 * - 'new-chat': a new-chat page. Live: whatever appears there is asked now.
 * - 'answered': a conversation URL reached from a new-chat page (or a page
 *   load) right after a question was submitted in this tab. Live.
 * - 'opened': an existing conversation opened as it was. Not live: the
 *   turns on it are past.
 *
 * lastPath is null on the first scan after the page loads.
 */
export function conversationTransition(
  host: string,
  lastPath: string | null,
  path: string,
  hasMessages: boolean,
  recentSubmit: () => boolean,
): 'same' | 'moved' | 'new-chat' | 'answered' | 'opened' {
  if (path === lastPath) {
    return 'same'
  }

  const key = conversationKey(host, path)
  const lastKey = lastPath === null ? undefined : conversationKey(host, lastPath)

  if (key === null) {
    return lastKey === null && hasMessages ? 'moved' : 'new-chat'
  }

  if (key === lastKey) {
    return 'moved'
  }

  return lastKey !== null && lastKey !== undefined
    ? 'opened'
    : recentSubmit() ? 'answered' : 'opened'
}
