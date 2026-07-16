/**
 * Page HTML Capture Module
 * 
 * Browser and Service Worker modules for periodic page HTML capture
 * on chatbot platforms with backend configuration support.
 * 
 * Configuration schema (`page_html_capture` block in AppConfiguration):
 * {
 *   "enabled": true,
 *   "platformConfigs": {
 *     "chatgpt": { "enabled": true, "captureIntervalMs": 10000 },
 *     "claude": { "enabled": true, "captureIntervalMs": 10000 },
 *     "perplexity": { "enabled": true, "captureIntervalMs": 10000 },
 *     "gemini": { "enabled": true, "captureIntervalMs": 10000 },
 *     "copilot": { "enabled": true, "captureIntervalMs": 10000 }
 *   }
 * }
 */

export { pageHtmlCaptureModule as pageCaptureModule } from './browser.mts'
export type { PageHtmlCaptureConfig } from './browser.mts'

export { pageHtmlCaptureModule as pageCaptureSWModule } from './service-worker.mts'
export type { PageHtmlCapture, PageHtmlCaptureStorageConfig } from './service-worker.mjs'
