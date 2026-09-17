import { test, expect } from '@playwright/test'

/**
 * GeminiParser unit tests.
 * Tests run against chatbots/gemini-test-page.html, a minimal fixture
 * built from the live production selector config (AppConfiguration
 * id=5 "pilot_ai_off", llm_capture.platforms.gemini). The parser is
 * loaded via chatbots-shim.bundle.js which exposes it on
 * window.__GeminiParser.
 *
 * No confirmed capture bug exists for Gemini in the 2026-09 pilot data
 * (0/22 contaminated interaction rows, vs. 16/36 for ChatGPT and 2 for
 * Perplexity). These tests are proactive: they lock in current correct
 * behavior and probe the same failure SHAPE that hit ChatGPT (status/
 * chrome text ending up in captured content) so a future selector or
 * markup change that introduces it gets caught immediately rather than
 * surfacing in a live study months later.
 */

const GEMINI_SELECTORS = {
  copyAction: '.response-footer.complete',
  userMessage: '.conversation-container user-query-content .query-content .query-text-line',
  busyIndicator: '.markdown.markdown-main-panel[aria-busy="true"]',
  sourceAnchors: 'a[href^="http"]',
  completeFooter: '.response-footer.complete',
  assistantMessage: '.conversation-container model-response message-content .markdown.markdown-main-panel',
  responseContainer: '.conversation-container model-response',
}

test.describe('GeminiParser', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/chatbots/gemini-test-page.html')
    await page.waitForFunction(() => (window as unknown as { testUtilitiesReady?: boolean }).testUtilitiesReady === true)
    await page.waitForFunction(() => (window as unknown as { __chatbotsShimLoaded?: boolean }).__chatbotsShimLoaded === true)
  })

  test('extracts clean question and response text for a normal turn', async ({ page }) => {
    const interactions = await page.evaluate((selectors) => {
      const ParserCtor = (window as unknown as { __GeminiParser: new (config: unknown) => { extractInteractions: () => Array<{ type: string; content: string }> } }).__GeminiParser
      const parser = new ParserCtor({ selectors })
      return parser.extractInteractions()
    }, GEMINI_SELECTORS)

    const questions = interactions.filter((i) => i.type === 'question')
    const responses = interactions.filter((i) => i.type === 'response')

    expect(questions.some((q) => q.content === 'What is the capital of France?')).toBe(true)
    expect(responses.some((r) => r.content === 'The capital of France is Paris.')).toBe(true)
  })

  test('strips the "You said" screen-reader prefix from questions', async ({ page }) => {
    const interactions = await page.evaluate((selectors) => {
      const ParserCtor = (window as unknown as { __GeminiParser: new (config: unknown) => { extractInteractions: () => Array<{ type: string; content: string }> } }).__GeminiParser
      const parser = new ParserCtor({ selectors })
      return parser.extractInteractions()
    }, GEMINI_SELECTORS)

    const questions = interactions.filter((i) => i.type === 'question')
    const gasPricesQuestion = questions.find((q) => q.content.includes('gas prices'))

    expect(gasPricesQuestion).toBeDefined()
    expect(gasPricesQuestion?.content).toBe('What are gas prices in California right now?')
    expect(gasPricesQuestion?.content.toLowerCase()).not.toContain('you said')
  })

  test('a still-streaming response (aria-busy=true) is captured as its literal partial text, not chrome text', async ({ page }) => {
    const interactions = await page.evaluate((selectors) => {
      const ParserCtor = (window as unknown as { __GeminiParser: new (config: unknown) => { extractInteractions: () => Array<{ type: string; content: string }> } }).__GeminiParser
      const parser = new ParserCtor({ selectors })
      return parser.extractInteractions()
    }, GEMINI_SELECTORS)

    const responses = interactions.filter((i) => i.type === 'response')
    const streamingResponse = responses.find((r) => r.content.includes('Based on the available'))

    // extractInteractions() does not gate on completion -- that's
    // isResponseComplete()'s job for the caller. Document that today it
    // returns the partial text verbatim: no status/chrome string appears
    // in place of (or prepended to) the in-progress content.
    expect(streamingResponse).toBeDefined()
    expect(streamingResponse?.content).toBe('Based on the available')
  })

  test('isResponseComplete() reports false for a turn with no response-footer, true once it is present', async ({ page }) => {
    // completeFooter and copyAction resolve to the same selector in this
    // platform's live config (.response-footer.complete), so its presence
    // is the actual completion signal isResponseComplete() acts on here --
    // this asserts that signal is read correctly, not aria-busy in
    // isolation (turn 3 lacks both the footer AND has aria-busy=true).
    const result = await page.evaluate((selectors) => {
      const ParserCtor = (window as unknown as { __GeminiParser: new (config: unknown) => { isResponseComplete: (c?: string) => boolean } }).__GeminiParser
      const parser = new ParserCtor({ selectors })
      return {
        streaming: parser.isResponseComplete('Based on the available'),
        complete: parser.isResponseComplete('The capital of France is Paris.'),
      }
    }, GEMINI_SELECTORS)

    expect(result.streaming).toBe(false)
    expect(result.complete).toBe(true)
  })

  test('never returns response content matching known chrome/status strings from other platforms', async ({ page }) => {
    const interactions = await page.evaluate((selectors) => {
      const ParserCtor = (window as unknown as { __GeminiParser: new (config: unknown) => { extractInteractions: () => Array<{ type: string; content: string }> } }).__GeminiParser
      const parser = new ParserCtor({ selectors })
      return parser.extractInteractions()
    }, GEMINI_SELECTORS)

    // Cross-platform smoke check: none of the chrome strings that
    // contaminated ChatGPT/Perplexity capture should ever appear verbatim
    // as an entire Gemini response.
    const knownChromeStrings = [
      'Searching the web',
      'ChatGPT said:',
      'Sign up and repeat your request.',
    ]
    const responses = interactions.filter((i) => i.type === 'response')

    for (const response of responses) {
      expect(knownChromeStrings).not.toContain(response.content.trim())
    }
  })
})
