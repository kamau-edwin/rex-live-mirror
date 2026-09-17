/**
 * Chatbot parser test shim.
 * Exposes each platform parser class on window so Playwright tests can
 * instantiate and test it directly against a fixture page's DOM.
 */
import { ChatGPTParser } from '../../src/chatbots/chatgpt.js'
import { PerplexityParser } from '../../src/chatbots/perplexity.js'
import { GeminiParser } from '../../src/chatbots/gemini.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any

g.__ChatGPTParser = ChatGPTParser
g.__PerplexityParser = PerplexityParser
g.__GeminiParser = GeminiParser
g.__chatbotsShimLoaded = true
