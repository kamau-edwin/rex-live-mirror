/**
 * Claude Parser
 * Extracts Q&A pairs from Claude interface
 *
 * INCOMPLETE relative to the other platform parsers: no isResponseComplete()
 * (nothing gates capture on the response actually finishing) and no
 * extractSources(). It implements MinimalChatbotParser, not ChatbotParser,
 * specifically so that gap stays visible at the type level -- see
 * ./parser.ts for what's still needed before this can be promoted to the
 * full ChatbotParser contract. extractInteractions() also iterates
 * assistantMessage directly with no turn-container/content-selector split
 * (see chatgpt.ts's fixed version and its comment for why that specific
 * shape caused a second-turn response desync there); this parser hasn't
 * been exercised against a real multi-turn Claude conversation to confirm
 * whether the same failure mode applies here.
 */

import type { MinimalChatbotParser } from './parser.js'

export interface ParsedInteraction {
  type: 'question' | 'response'
  content: string
}

export interface ClaudeSelectors {
  userMessage?: string
  assistantMessage?: string
}

export interface ClaudeConfig {
  enabled?: boolean
  selectors?: ClaudeSelectors
}

export class ClaudeParser implements MinimalChatbotParser {
  name = 'claude'
  selectors: ClaudeSelectors

  constructor(config?: ClaudeConfig) {
    // Use config selectors or defaults
    this.selectors = config?.selectors || {
      userMessage: '[data-is-user="true"]',
      assistantMessage: '[data-is-user="false"]',
    }
    console.log('[ClaudeParser] Initialized with selectors:', this.selectors)
  }

  extractInteractions(): ParsedInteraction[] {
    const interactions: ParsedInteraction[] = []

    // Find user messages using config selector
    if (this.selectors.userMessage) {
      const userMessages = document.querySelectorAll(this.selectors.userMessage)
      console.log(`[ClaudeParser] Found ${userMessages.length} user message elements`)
      userMessages.forEach((msg) => {
        const content = msg.textContent?.trim()
        if (content) {
          interactions.push({
            type: 'question',
            content,
          })
        }
      })
    }

    // Find assistant messages using config selector
    if (this.selectors.assistantMessage) {
      const assistantMessages = document.querySelectorAll(this.selectors.assistantMessage)
      console.log(`[ClaudeParser] Found ${assistantMessages.length} assistant message elements`)
      assistantMessages.forEach((msg) => {
        const content = msg.textContent?.trim()
        if (content) {
          interactions.push({
            type: 'response',
            content,
          })
        }
      })
    }

    return interactions
  }
}
