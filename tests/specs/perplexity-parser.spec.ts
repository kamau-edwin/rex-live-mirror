import { test, expect } from '@playwright/test'

/**
 * PerplexityParser unit tests.
 * Tests run against chatbots/perplexity-test-page.html, a minimal fixture
 * built from the live production selector config (AppConfiguration
 * id=5 "pilot_ai_off", llm_capture.platforms.perplexity). The parser is
 * loaded via chatbots-shim.bundle.js which exposes it on
 * window.__PerplexityParser.
 *
 * Regression coverage for the 2026-09 pilot incident: 2 participants had
 * "Sign up and repeat your request." (Perplexity's signup/rate-limit wall)
 * captured as interaction_response_content instead of a real answer.
 */

const PERPLEXITY_SELECTORS = {
  copyAction: 'button[aria-label="Copy"]',
  userQuestion: 'div.group\\/user-bubble span.select-text',
  busyIndicator: '[aria-busy="true"]',
  citationTitle: 'span.citation.inline[data-pplx-citation-url]',
  citationElements: 'a[href*="http"], [data-pplx-citation-url]',
  messageContainer: '.scrollable-container',
  assistantResponse: 'div[id^="markdown-content"], div[data-renderer="lm"]',
  responseContainer: 'div.flex.flex-col.flex-1.min-w-0.gap-4',
  sourceCloseButton: 'button[aria-label="Collapse sidebar"]',
  sourceToggleButton:
    'button[role="tab"][aria-controls$="-content-sources"], button[aria-controls$="-content-sources"]',
  sourceDetailAnchors: 'a[href^="http"]',
}

test.describe('PerplexityParser', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/chatbots/perplexity-test-page.html')
    await page.waitForFunction(() => (window as unknown as { testUtilitiesReady?: boolean }).testUtilitiesReady === true)
    await page.waitForFunction(() => (window as unknown as { __chatbotsShimLoaded?: boolean }).__chatbotsShimLoaded === true)
  })

  test('extracts clean question and response text for a normal turn', async ({ page }) => {
    const interactions = await page.evaluate((selectors) => {
      const ParserCtor = (window as unknown as { __PerplexityParser: new (config: unknown) => { extractInteractions: () => Array<{ type: string; content: string }> } }).__PerplexityParser
      const parser = new ParserCtor({ selectors })
      return parser.extractInteractions()
    }, PERPLEXITY_SELECTORS)

    const questions = interactions.filter((i) => i.type === 'question')
    const responses = interactions.filter((i) => i.type === 'response')

    expect(questions.some((q) => q.content === 'Have California gas prices increased since Labor Day?')).toBe(true)
    expect(responses.some((r) => r.content === 'Yes, California gas prices have risen slightly since Labor Day.')).toBe(true)
  })

  test('never captures the signup/rate-limit wall as a response', async ({ page }) => {
    const interactions = await page.evaluate((selectors) => {
      const ParserCtor = (window as unknown as { __PerplexityParser: new (config: unknown) => { extractInteractions: () => Array<{ type: string; content: string }> } }).__PerplexityParser
      const parser = new ParserCtor({ selectors })
      return parser.extractInteractions()
    }, PERPLEXITY_SELECTORS)

    const responses = interactions.filter((i) => i.type === 'response')
    for (const response of responses) {
      expect(response.content).not.toContain('Sign up')
      expect(response.content).not.toBe('Sign up and repeat your request.')
    }
  })

  test('the Kushner question was asked but produced no captured response', async ({ page }) => {
    const interactions = await page.evaluate((selectors) => {
      const ParserCtor = (window as unknown as { __PerplexityParser: new (config: unknown) => { extractInteractions: () => Array<{ type: string; content: string }> } }).__PerplexityParser
      const parser = new ParserCtor({ selectors })
      return parser.extractInteractions()
    }, PERPLEXITY_SELECTORS)

    const askedKushnerQuestion = interactions.some(
      (i) => i.type === 'question' && i.content.includes('Kushner'),
    )
    expect(askedKushnerQuestion).toBe(true)

    const responseContents = new Set(interactions.filter((i) => i.type === 'response').map((r) => r.content))
    expect(responseContents).toEqual(new Set(['Yes, California gas prices have risen slightly since Labor Day.']))
  })
})
