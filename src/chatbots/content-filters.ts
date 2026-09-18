/**
 * Shared UI-chrome denylist for chatbot response extraction.
 *
 * A platform's assistant-turn DOM sometimes exposes status/chrome text
 * (a reasoning timer, a "searching the web" indicator, an accessibility
 * label, a signup wall) as the only thing a selector can find -- either
 * because the real content selector didn't match and extraction fell back
 * to a broader container, or because the platform renders that string
 * inside the same node as the answer while a response is incomplete.
 * These strings are not answers and must never be stored as
 * interaction_response_content. Built from the 2026-09 pilot incident
 * where 16/36 ChatGPT rows and 2 Perplexity rows captured chrome text
 * instead of a real response.
 *
 * Every pattern is anchored to the START of the string (^) rather than a
 * free substring match -- a real answer that happens to mention "searching
 * the web" mid-sentence must not be discarded or mangled. This is also why
 * these are safe to use both to reject chrome-only content AND to strip a
 * chrome PREFIX: confirmed in production data, chrome text is concatenated
 * directly before the real answer with no separator (e.g. "Worked for
 * 41sYes -- the article you pasted is real...", where the timer badge and
 * the assistant's markdown text are both descendants of the same matched
 * prose element -- container-level fallback is not the only way this
 * happens). Add new entries only for prefixes observed at the START of a
 * bad row's captured content, not fragments seen mid-answer.
 */

export interface ChromeTextPattern {
  pattern: RegExp
  description: string
}

export const CHATGPT_CHROME_PATTERNS: ChromeTextPattern[] = [
  { pattern: /^Searching the web\.*/i, description: 'web-search status indicator' },
  { pattern: /^Worked for \d+s\.*/i, description: 'reasoning-timer badge' },
  { pattern: /^(Answering|Answered) with ChatGPT( Plus preview)?\.*/i, description: 'model badge' },
  { pattern: /^ChatGPT said:\s*/i, description: 'accessibility label' },
  { pattern: /^You said:\s*/i, description: 'user-message accessibility label' },
]

export const PERPLEXITY_CHROME_PATTERNS: ChromeTextPattern[] = [
  { pattern: /^Sign up (and|to) .*repeat your request\.*$/i, description: 'signup/rate-limit wall' },
  { pattern: /^Sign up to continue\.*$/i, description: 'signup wall' },
]

/**
 * True if `content` is ENTIRELY known chrome/status text with no real
 * answer alongside it (i.e. stripping every matching prefix leaves nothing).
 */
export function isChromeOnlyContent(content: string, patterns: ChromeTextPattern[]): boolean {
  const trimmed = content.trim()
  if (!trimmed) {
    return false
  }
  return stripChromePrefixes(trimmed, patterns).length === 0
}

/**
 * Repeatedly strips any known chrome prefix from the start of `content`
 * (ChatGPT can stack more than one, e.g. a model badge followed by a
 * reasoning timer) and returns what's left, trimmed. Safe to call on
 * clean content -- returns it unchanged if no pattern matches at the start.
 */
export function stripChromePrefixes(content: string, patterns: ChromeTextPattern[]): string {
  let result = content.trim()
  let changed = true
  while (changed) {
    changed = false
    for (const { pattern } of patterns) {
      const match = result.match(pattern)
      if (match && match.index === 0) {
        result = result.slice(match[0].length).trim()
        changed = true
      }
    }
  }
  return result
}
