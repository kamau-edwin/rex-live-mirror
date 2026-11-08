import { test, expect } from '@playwright/test'

import { conversationKey, conversationTransition, isConversationPath, pastTurnIndexes, turnKeys, type PageTurn } from '../../src/live-turns.mjs'

const UUID_A = '6a1b2c3d-1111-2222-3333-444455556666'
const UUID_B = '7b2c3d4e-aaaa-bbbb-cccc-ddddeeeeffff'

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
    expect(isConversationPath('www.perplexity.ai', `/search/new/${UUID_A}`)).toBe(true)
    expect(isConversationPath('www.perplexity.ai', `/session/${UUID_A}`)).toBe(true)
    expect(isConversationPath('www.perplexity.ai', `/computer/tasks/${UUID_A}`)).toBe(true)
    expect(isConversationPath('www.perplexity.ai', '/discover/you')).toBe(false)
    expect(isConversationPath('www.perplexity.ai', '/spaces/my-space')).toBe(false)

    expect(isConversationPath('chatgpt.com', `/c/WEB:${UUID_A}`)).toBe(false)

    expect(isConversationPath('claude.ai', '/new')).toBe(false)
    expect(isConversationPath('claude.ai', '/chat/6a1b2c3d-1111-2222-3333-444455556666')).toBe(true)

    expect(isConversationPath('example.com', '/c/6a1b2c3d-1111')).toBe(false)
  })

  test('the same conversation at another URL keeps its key', () => {
    expect(conversationKey('www.perplexity.ai', `/search/new/${UUID_A}`)).toEqual(conversationKey('www.perplexity.ai', `/search/${UUID_A}`))
    expect(conversationKey('www.perplexity.ai', '/search/old-slug-AbCdEf0123456789xyz'))
      .toEqual(conversationKey('www.perplexity.ai', '/search/new-slug-AbCdEf0123456789xyz'))
    expect(conversationKey('chatgpt.com', `/g/g-p-111-social/c/${UUID_A}`)).toEqual(conversationKey('chatgpt.com', `/g/g-p-222-content/c/${UUID_A}`))
    expect(conversationKey('www.perplexity.ai', `/search/${UUID_A}`)).not.toEqual(conversationKey('www.perplexity.ai', `/search/${UUID_B}`))
  })

  test.describe('conversation transitions', () => {
    const never = (): boolean => false
    const always = (): boolean => true
    const t = (host: string, last: string | null, path: string, messages: boolean, recent: () => boolean) =>
      conversationTransition(host, last, path, messages, recent)

    test('an existing conversation loaded in a tab is opened, not live', () => {
      expect(t('gemini.google.com', null, '/app/0123abcd4567ef89', true, never)).toBe('opened')
    })

    test('switching to another existing conversation is opened, even right after asking', () => {
      expect(t('gemini.google.com', '/app/0123abcd4567ef89', '/app/fedcba9876543210', true, always)).toBe('opened')
      expect(t('www.perplexity.ai', `/session/${UUID_A}`, `/search/${UUID_B}`, true, always)).toBe('opened')
    })

    test('a new chat getting its URL after a question is answered (live)', () => {
      expect(t('gemini.google.com', '/app', '/app/0123abcd4567ef89', true, always)).toBe('answered')
      expect(t('chatgpt.com', '/', `/c/${UUID_A}`, true, always)).toBe('answered')
      expect(t('www.perplexity.ai', '/', `/search/${UUID_A}`, true, always)).toBe('answered')
      expect(t('www.perplexity.ai', '/', `/computer/tasks/${UUID_A}`, true, always)).toBe('answered')
    })

    test('a full-page navigation right after asking is answered (live)', () => {
      expect(t('www.perplexity.ai', null, `/search/${UUID_A}`, true, always)).toBe('answered')
    })

    test('leaving a new-chat page for an old conversation without asking is opened', () => {
      expect(t('chatgpt.com', '/', `/c/${UUID_A}`, true, never)).toBe('opened')
    })

    test('the same conversation moving URL carries over', () => {
      expect(t('www.perplexity.ai', `/search/new/${UUID_A}`, `/search/${UUID_A}`, true, never)).toBe('moved')
      expect(t('chatgpt.com', `/g/g-p-111-social/c/${UUID_A}`, `/g/g-p-222-content/c/${UUID_A}`, true, never)).toBe('moved')
    })

    test('a new chat with messages whose URL changes before its conversation URL carries over', () => {
      expect(t('chatgpt.com', '/', `/c/WEB:${UUID_A}`, true, never)).toBe('moved')
    })

    test('a new-chat page is new-chat (live)', () => {
      expect(t('chatgpt.com', `/c/${UUID_A}`, '/', false, never)).toBe('new-chat')
      expect(t('www.perplexity.ai', null, '/', false, never)).toBe('new-chat')
    })

    test('an unchanged path is same', () => {
      expect(t('chatgpt.com', `/c/${UUID_A}`, `/c/${UUID_A}`, true, never)).toBe('same')
    })
  })
})
