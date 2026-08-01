/**
 * Shared chatbot parser capability contract.
 *
 * This does NOT prescribe how a platform finds its DOM elements -- each
 * parser (chatgpt.ts, gemini.ts, perplexity.ts, claude.ts) owns its own
 * selector schema, config shape, and traversal strategy, because platform
 * DOMs genuinely differ (e.g. Gemini's sources live in a separate dialog
 * decoupled from the response container; Perplexity's response lives in a
 * tab panel; ChatGPT's turn boundary and leaf content selector are distinct
 * nodes). What this DOES fix in one place is the shape every parser is
 * expected to expose, so a platform's capture logic can be swapped out from
 * "what config values does the DOM need" without touching call sites in
 * browser.mts/service-worker.mts, and so a new platform has a checklist to
 * implement against instead of copying whichever existing parser is handiest.
 */

export interface ParsedInteraction {
  type: 'question' | 'response'
  content: string
  question_timestamp?: number
}

export interface ExtractedSource {
  source_title: string
  source_url?: string
}

export interface ExtractedSourceGroup {
  domain_title: string
  domain_name: string
  sources: ExtractedSource[]
}

export type SourceExtractionClassification =
  | 'success'
  | 'none'
  | 'terminal_empty'
  | 'data_capture_error'
  | 'panel_opening_failure'

export interface SourceExtractionResult {
  sources: ExtractedSourceGroup[]
  source_extraction: SourceExtractionClassification
  close_panel?: boolean
  sources_html?: string
}

/**
 * Every platform parser MUST implement this. It is the minimum needed to
 * capture a question/response pair and know the extraction actually ran.
 *
 * extractInteractions() is required to be config-selector-driven end to end:
 * the DOM structure a platform uses to mark "one turn" vs. "the text within
 * a turn" WILL drift over time (this is exactly the bug fixed in chatgpt.ts
 * for the second-turn response desync -- ChatGPT's assistantMessage selector
 * matched multiple leaf nodes per turn, so extraction had to be re-scoped to
 * iterate the one-per-turn assistantTurnContainer selector instead, with the
 * leaf content selector resolved *within* each turn container). A parser
 * that hardcodes which selector plays which role, instead of keeping that
 * mapping in its own selector schema/config, will need a rebuild every time
 * the target site's markup changes shape -- not just a config push. The
 * schema itself (selector NAMES and what role each plays -- turn boundary
 * vs. leaf content vs. completion signal vs. source toggle) is what must stay
 * stable; only the selector VALUES are expected to change over a site's
 * lifetime.
 */
export interface ChatbotParser {
  readonly name: string

  extractInteractions(): ParsedInteraction[]

  /**
   * Whether the latest turn's response has finished streaming and is safe to
   * capture. Some platforms (Gemini, Perplexity) need the caller to identify
   * which response they're asking about via an optional argument (e.g. when
   * checking a queued/stale turn against a fast-moving DOM); others (ChatGPT)
   * always resolve to whatever is currently the latest turn in the DOM.
   * Implementations are free to accept that optional argument or ignore it,
   * but MUST NOT silently accept an argument that changes nothing (see the
   * chatgpt.ts getCompletionDecision() bug where a caller passed
   * interaction.content into a zero-parameter method) -- either the
   * parameter is real and scopes the check, or it's omitted entirely.
   */
  isResponseComplete(responseContent?: string): boolean

  /**
   * Sources may not always be extractable synchronously (Perplexity has to
   * open a sources panel and wait for it to populate), so this is allowed to
   * return a Promise either way. The result shape itself also varies by how
   * rich a platform's source classification needs to be: ChatGPT returns a
   * flat list (no panel-open/classification state to track), Gemini groups
   * by domain, and Perplexity additionally reports WHY extraction did or
   * didn't succeed (panel never opened vs. genuinely no sources, etc) since
   * its sources live behind an async, closeable panel. All three are valid;
   * pick the shape that matches how much state your platform's source UI
   * actually has -- don't wrap a synchronous, always-present source list in
   * SourceExtractionResult's panel/classification fields just for uniformity.
   */
  extractSources(
    responseContentOrContainer?: string | Element,
  ):
    | ExtractedSource[]
    | ExtractedSourceGroup[]
    | SourceExtractionResult
    | Promise<ExtractedSource[] | ExtractedSourceGroup[] | SourceExtractionResult>
}

/**
 * A parser that has NOT yet implemented completion-detection or source
 * extraction (e.g. claude.ts today). This is an explicit, typed "not built
 * yet" state rather than a silent gap -- callers that only need question/
 * response capture (no completion gating, no sources) can depend on this
 * narrower contract, and it's a compile-time-visible checklist of what's
 * still missing before a platform can be promoted to ChatbotParser.
 */
export interface MinimalChatbotParser {
  readonly name: string
  extractInteractions(): ParsedInteraction[]
}
