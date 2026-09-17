import { test, expect } from '@playwright/test'

/**
 * ChatGPTParser unit tests.
 * Tests run against chatbots/chatgpt-test-page.html, a minimal fixture
 * built from the live production selector config (AppConfiguration
 * id=5 "pilot_ai_off", llm_capture.platforms.chatgpt) rather than a full
 * page capture -- only the assistant-turn DOM shape the parser actually
 * reads. The parser is loaded via chatbots-shim.bundle.js which exposes
 * it on window.__ChatGPTParser.
 *
 * Regression coverage for the 2026-09 pilot incident: 16/36 captured
 * ChatGPT interaction_response_content values were UI chrome text
 * ("Searching the web", "Worked for Ns", "ChatGPT said:", "Answering
 * with ChatGPT Plus preview") instead of a real answer.
 */

const CHATGPT_SELECTORS = {
  userMessage:
    'li[data-message-role="user"] [data-user-message-copy], [data-message-author-role="user"], li[data-message-role="user"]',
  streamActive: '[data-stream-active="true"], [data-is-streaming="true"], div[data-stream-active]',
  writingBlock: '[data-writing-block], section[data-turn="assistant"] [data-waiting-for-response]',
  assistantContent: 'section[data-turn="assistant"] [data-conversation-screenshot-content]',
  assistantMessage: 'li[data-message-role="assistant"] [data-assistant-markdown]',
  citationElements: 'section[data-turn="assistant"] a[href^="http"]',
  copyResponseButton: 'button[data-testid="copy-turn-action-button"]',
  stopGeneratingButton: 'button[data-testid="stop-button"], button[aria-label="Stop answering"]',
  assistantTurnContainer:
    'li[data-message-role="assistant"], [data-testid^="conversation-turn-"][data-turn="assistant"], section[data-turn="assistant"]',
  conversationTurnFallback:
    'ol[data-conversation-transcript] > li[data-message-role], [data-conversation-transcript] > li[data-message-role], [data-testid^="conversation-turn-"], [data-testid="conversation-turn"]',
}

test.describe('ChatGPTParser', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/chatbots/chatgpt-test-page.html')
    await page.waitForFunction(() => (window as unknown as { testUtilitiesReady?: boolean }).testUtilitiesReady === true)
    await page.waitForFunction(() => (window as unknown as { __chatbotsShimLoaded?: boolean }).__chatbotsShimLoaded === true)
  })

  test('extracts clean question and response text for a normal turn', async ({ page }) => {
    const interactions = await page.evaluate((selectors) => {
      const ParserCtor = (window as unknown as { __ChatGPTParser: new (config: unknown) => { extractInteractions: () => Array<{ type: string; content: string }> } }).__ChatGPTParser
      const parser = new ParserCtor({ selectors, fallback_mode: 'append' })
      return parser.extractInteractions()
    }, CHATGPT_SELECTORS)

    // extractInteractions() is a raw per-call extractor -- de-duplication
    // across overlapping selector alternatives (e.g. userMessage's union
    // matching both an ancestor and descendant node) happens downstream in
    // browser.mts, not here. Assert on presence/content, not exact indices.
    const questions = interactions.filter((i) => i.type === 'question')
    const responses = interactions.filter((i) => i.type === 'response')

    expect(questions.some((q) => q.content === 'What is the capital of France?')).toBe(true)
    expect(responses.some((r) => r.content === 'The capital of France is Paris.')).toBe(true)
  })

  test('does not capture "Searching the web" as a response when the prose selector has not rendered yet', async ({ page }) => {
    const interactions = await page.evaluate((selectors) => {
      const ParserCtor = (window as unknown as { __ChatGPTParser: new (config: unknown) => { extractInteractions: () => Array<{ type: string; content: string }> } }).__ChatGPTParser
      const parser = new ParserCtor({ selectors, fallback_mode: 'append' })
      return parser.extractInteractions()
    }, CHATGPT_SELECTORS)

    const responses = interactions.filter((i) => i.type === 'response')
    for (const response of responses) {
      expect(response.content).not.toContain('Searching the web')
    }

    // The gas-prices question (turn 2) was asked...
    const askedGasPricesQuestion = interactions.some(
      (i) => i.type === 'question' && i.content.includes('gas prices'),
    )
    expect(askedGasPricesQuestion).toBe(true)

    // ...but turn 2 has no valid response captured at all -- every response
    // that WAS captured must belong to turn 1 or turn 3, never chrome text
    // standing in for turn 2's missing answer.
    const distinctResponseContents = new Set(responses.map((r) => r.content))
    expect(distinctResponseContents).toEqual(
      new Set(['The capital of France is Paris.', 'Yes, the claim is accurate based on the data available.']),
    )
  })

  test('strips a leading reasoning-timer prefix instead of discarding the whole response', async ({ page }) => {
    const interactions = await page.evaluate((selectors) => {
      const ParserCtor = (window as unknown as { __ChatGPTParser: new (config: unknown) => { extractInteractions: () => Array<{ type: string; content: string }> } }).__ChatGPTParser
      const parser = new ParserCtor({ selectors, fallback_mode: 'append' })
      return parser.extractInteractions()
    }, CHATGPT_SELECTORS)

    const stockMarketResponse = interactions.find(
      (i) => i.type === 'response' && i.content.includes('claim is accurate'),
    )

    expect(stockMarketResponse).toBeDefined()
    expect(stockMarketResponse?.content).not.toContain('Worked for')
    expect(stockMarketResponse?.content).toBe('Yes, the claim is accurate based on the data available.')
  })

  test('never returns a response whose entire content is a known chrome string', async ({ page }) => {
    const interactions = await page.evaluate((selectors) => {
      const ParserCtor = (window as unknown as { __ChatGPTParser: new (config: unknown) => { extractInteractions: () => Array<{ type: string; content: string }> } }).__ChatGPTParser
      const parser = new ParserCtor({ selectors, fallback_mode: 'append' })
      return parser.extractInteractions()
    }, CHATGPT_SELECTORS)

    const knownChromeStrings = ['Searching the web', 'Worked for', 'ChatGPT said:', 'Answering with ChatGPT']
    const responses = interactions.filter((i) => i.type === 'response')

    for (const response of responses) {
      const isChromeOnly = knownChromeStrings.some((chrome) => response.content.trim() === chrome)
      expect(isChromeOnly).toBe(false)
    }
  })

  test('captures a valid response for turns 1 and 3, and none for turn 2', async ({ page }) => {
    const interactions = await page.evaluate((selectors) => {
      const ParserCtor = (window as unknown as { __ChatGPTParser: new (config: unknown) => { extractInteractions: () => Array<{ type: string; content: string }> } }).__ChatGPTParser
      const parser = new ParserCtor({ selectors, fallback_mode: 'append' })
      return parser.extractInteractions()
    }, CHATGPT_SELECTORS)

    const responseContents = new Set(interactions.filter((i) => i.type === 'response').map((i) => i.content))

    expect(responseContents.has('The capital of France is Paris.')).toBe(true)
    expect(responseContents.has('Yes, the claim is accurate based on the data available.')).toBe(true)

    // Turn 2 (gas prices) must not have produced ANY response entry --
    // valid or chrome-contaminated.
    const gasPricesResponse = [...responseContents].find((c) => c.toLowerCase().includes('gas price'))
    expect(gasPricesResponse).toBeUndefined()
  })

  test('a turn that was chrome-only on first extraction is captured correctly once the real answer renders', async ({ page }) => {
    // Production data (2026-09 pilot behavior analysis) shows the chatbot
    // almost always DOES finish rendering a real answer a few seconds to
    // just over a minute after a "Searching the web"/reasoning-timer state
    // -- the participant stayed on the chatbot tab the whole time in every
    // observed case. extractInteractions() dropping chrome-only content
    // (rather than capturing it) means that turn produces NO interaction at
    // all on the poll that catches the transient chrome state, so it isn't
    // marked "seen" anywhere -- the live extension's MutationObserver-driven
    // recapture on the next DOM change (browser.mts's characterData-watching
    // observer) gets an unblocked second look. This test proves that
    // mechanism at the parser level: calling extractInteractions() again
    // after the DOM mutates from chrome-only to a real answer must return
    // the real answer, with no special-cased "retry" logic needed in the
    // parser itself.
    const firstPassResponses = await page.evaluate((selectors) => {
      const ParserCtor = (window as unknown as { __ChatGPTParser: new (config: unknown) => { extractInteractions: () => Array<{ type: string; content: string }> } }).__ChatGPTParser
      const parser = new ParserCtor({ selectors, fallback_mode: 'append' })
      ;(window as unknown as { __persistentParser: unknown }).__persistentParser = parser
      return parser.extractInteractions().filter((i) => i.type === 'response')
    }, CHATGPT_SELECTORS)

    // First pass: turn 2 (gas prices) contributes nothing yet.
    expect(firstPassResponses.some((r) => r.content.toLowerCase().includes('gas price'))).toBe(false)

    // Simulate the chatbot finishing its response: the "Searching the web"
    // status pill is replaced by the real prose element, exactly as ChatGPT
    // mutates the turn 2 container in production once generation completes.
    await page.evaluate(() => {
      const turns = Array.from(document.querySelectorAll('li[data-message-role="assistant"]'))
      const turn2 = turns[1]
      const statusPill = turn2.querySelector('.status-pill')
      statusPill?.remove()
      const wrapper = document.createElement('div')
      wrapper.setAttribute('data-message-author-role', 'assistant')
      wrapper.innerHTML = '<div data-conversation-screenshot-content>Gas prices in California are currently above the national average.</div>'
      turn2.querySelector('section')?.prepend(wrapper)
    })

    const secondPassResponses = await page.evaluate((selectors) => {
      const parser = (window as unknown as { __persistentParser: { extractInteractions: () => Array<{ type: string; content: string }> } }).__persistentParser
      return parser.extractInteractions().filter((i) => i.type === 'response')
    }, CHATGPT_SELECTORS)

    const recoveredResponse = secondPassResponses.find((r) => r.content.toLowerCase().includes('gas price'))
    expect(recoveredResponse).toBeDefined()
    expect(recoveredResponse?.content).toBe('Gas prices in California are currently above the national average.')
    expect(recoveredResponse?.content).not.toContain('Searching the web')
  })
})
