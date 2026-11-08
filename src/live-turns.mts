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

/**
 * Whether a path is an existing conversation, as opposed to a new-chat page.
 * Hosts not listed return false, which keeps every turn (the previous
 * behaviour).
 */
export function isConversationPath(host: string, path: string): boolean {
  if (/(^|\.)chatgpt\.com$/.test(host)) {
    // /c/<id>, also inside custom GPTs and projects (/g/<gpt>/c/<id>); shared chats.
    return /\/c\/[0-9a-f-]{8,}/i.test(path) || /^\/share\/[^/]+/.test(path)
  }

  if (/(^|\.)gemini\.google\.com$/.test(host)) {
    // /app/<id> or /u/<n>/app/<id>; a Gem's conversation /gem/<gem>/<id>.
    return /\/app\/[0-9a-f]{8,}/i.test(path) || /\/gem\/[^/]+\/[0-9a-f]{8,}/i.test(path)
  }

  if (/(^|\.)perplexity\.ai$/.test(host)) {
    return /^\/search\/(?!new\/?$)[^/]+/.test(path)
  }

  if (/(^|\.)claude\.ai$/.test(host)) {
    return /^\/chat\/[0-9a-f-]{8,}/i.test(path)
  }

  return false
}
