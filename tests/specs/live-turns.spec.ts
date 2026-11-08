import { test, expect } from '@playwright/test'

import { isConversationPath, pastTurnIndexes, turnKeys, type PageTurn } from '../../src/live-turns.mjs'

/**
 * Live-only capture: past turns on a chatbot page (an existing conversation
 * opened, or older turns loaded by scrolling up) are told apart from turns
 * asked now.
 */

const q = (content: string): PageTurn => ({ type: 'question', content })
const r = (content: string): PageTurn => ({ type: 'response', content })

function scan(turns: PageTurn[], known: Set<string>, live: boolean): { keys: string[], past: number[] } {
  const keys = turnKeys(turns)
  const past = pastTurnIndexes(keys, (key) => known.has(key), live)

  return { keys, past: [...past].sort((a, b) => a - b) }
}

test.describe('live-turns', () => {
  test('an existing conversation opened: every turn on the page is past', () => {
    const { past } = scan([q('one'), r('a1'), q('two'), r('a2')], new Set(), false)

    expect(past).toEqual([0, 1, 2, 3])
  })

  test('a new chat: turns as they appear are live', () => {
    const { past } = scan([q('hello'), r('hi there')], new Set(), true)

    expect(past).toEqual([])
  })

  test('a follow-up asked in an opened conversation is live, the earlier turns stay past', () => {
    const opened = [q('one'), r('a1'), q('two'), r('a2')]
    const known = new Set(scan(opened, new Set(), false).keys)

    // The participant submits: the conversation becomes live.
    const { past, keys } = scan([...opened, q('three'), r('a3')], known, true)

    expect(past).toEqual([])
    expect(known.has(keys[4])).toBe(false)
  })

  test('older turns loaded by scrolling up are past, the live turns below are not', () => {
    const live = [q('three'), r('a3'), q('four')]
    const known = new Set(scan(live, new Set(), true).keys)

    const { past } = scan([q('one'), r('a1'), q('two'), r('a2'), ...live, r('a4')], known, true)

    expect(past).toEqual([0, 1, 2, 3])
  })

  test('the same question asked again later is its own turn', () => {
    const first = [q('again?'), r('yes')]
    const known = new Set(scan(first, new Set(), true).keys)

    const { keys, past } = scan([...first, q('again?'), r('still yes')], known, true)

    expect(keys[2]).not.toEqual(keys[0])
    expect(past).toEqual([])
  })

  test('a common opening in a response is keyed by its question', () => {
    const keys = turnKeys([q('first'), r('Great question!'), q('second'), r('Great question!')])

    expect(keys[1]).not.toEqual(keys[3])
  })

  test('keys ignore whitespace differences between scans', () => {
    expect(turnKeys([q('  what   is\nthis ')])).toEqual(turnKeys([q('what is this')]))
  })

  test('conversation URLs and new-chat pages', () => {
    expect(isConversationPath('chatgpt.com', '/')).toBe(false)
    expect(isConversationPath('chatgpt.com', '/c/6a1b2c3d-1111-2222-3333-444455556666')).toBe(true)
    expect(isConversationPath('chatgpt.com', '/g/g-abc123-my-gpt')).toBe(false)
    expect(isConversationPath('chatgpt.com', '/g/g-abc123-my-gpt/c/6a1b2c3d-1111-2222-3333-444455556666')).toBe(true)
    expect(isConversationPath('chatgpt.com', '/share/6a1b2c3d-1111')).toBe(true)

    expect(isConversationPath('gemini.google.com', '/app')).toBe(false)
    expect(isConversationPath('gemini.google.com', '/app/0123abcd4567ef89')).toBe(true)
    expect(isConversationPath('gemini.google.com', '/u/1/app/0123abcd4567ef89')).toBe(true)
    expect(isConversationPath('gemini.google.com', '/gem/coding-partner')).toBe(false)
    expect(isConversationPath('gemini.google.com', '/gem/coding-partner/0123abcd4567ef89')).toBe(true)

    expect(isConversationPath('www.perplexity.ai', '/')).toBe(false)
    expect(isConversationPath('www.perplexity.ai', '/search/new')).toBe(false)
    expect(isConversationPath('www.perplexity.ai', '/search/what-is-x-AbCdEf0123456789xyz')).toBe(true)

    expect(isConversationPath('claude.ai', '/new')).toBe(false)
    expect(isConversationPath('claude.ai', '/chat/6a1b2c3d-1111-2222-3333-444455556666')).toBe(true)

    expect(isConversationPath('example.com', '/c/6a1b2c3d-1111')).toBe(false)
  })
})
