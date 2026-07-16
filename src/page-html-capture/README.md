# Page HTML Capture Configuration

Page HTML Capture is a reusable module from `@bric/rex-live-mirror` that periodically captures page HTML snapshots on chatbot platforms with full backend configuration support.

## Configuration Schema

Add this block to your `AppConfiguration` backend config to enable page HTML capture:

```json
{
  "page_html_capture": {
    "enabled": true,
    "platformConfigs": {
      "chatgpt": {
        "enabled": true,
        "captureIntervalMs": 10000
      },
      "claude": {
        "enabled": true,
        "captureIntervalMs": 10000
      },
      "perplexity": {
        "enabled": true,
        "captureIntervalMs": 10000
      },
      "gemini": {
        "enabled": true,
        "captureIntervalMs": 10000
      },
      "copilot": {
        "enabled": true,
        "captureIntervalMs": 10000
      }
    }
  }
}
```

## Configuration Options

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `enabled` | boolean | Master switch to enable/disable entire module | `true` |
| `platformConfigs.[platform].enabled` | boolean | Enable/disable capture for specific platform | `true` |
| `platformConfigs.[platform].captureIntervalMs` | number | How often to capture page HTML (milliseconds) | `10000` |

## Supported Platforms

- `chatgpt` — ChatGPT (chatgpt.com)
- `claude` — Claude (claude.ai)
- `perplexity` — Perplexity AI (perplexity.ai)
- `gemini` — Google Gemini (gemini.google.com)
- `copilot` — Microsoft Copilot (copilot.microsoft.com)

## Capture Behavior

### Browser-side Capture

1. **Initialization**: Module detects if user is on a supported platform on page load
2. **Periodic Capture**: On `enabled` platforms, captures page HTML every `captureIntervalMs` (minimum 5 seconds)
3. **Immediate Capture**: Sends one snapshot immediately when page loads
4. **Visibility Handling**: 
   - Pauses capture when page becomes hidden (tab switched away)
   - Resumes capture when page becomes visible again
5. **Final Capture**: On page unload (`beforeunload` event), sends a final capture with `isFinal: true` flag

### Service Worker-side Storage

1. **Receipt**: Stores captures in memory organized by URL
2. **Correlation Linkage**: Captures can be linked to interactions via `correlationId`
3. **Memory Management**: 
   - Max 100 captures per URL (oldest purged first)
   - Stale captures (>1 hour old) auto-pruned
4. **Analytics**: Emits `page_html_capture_final` event when final capture received

## Message Protocol

### Browser → Service Worker

```javascript
{
  messageType: 'pageHtmlCaptureData',
  capture: {
    captureId: string,           // Unique identifier
    platform: string,             // 'chatgpt', 'claude', etc.
    sequence: number,             // Incremented per page load
    url: string,                  // Page URL
    timestamp: number,            // Milliseconds since epoch
    isFinal: boolean,             // True only on page unload
    pageHtmlLength: number,       // Size of pageHtml
    pageHtml: string,             // Full HTML content
    correlationId?: string        // Optional link to interactions
  }
}
```

### Service Worker → Query Captures

```javascript
// By URL
chrome.runtime.sendMessage({
  messageType: 'getPageHtmlCaptures',
  url: 'https://chatgpt.com/c/...'
})

// By correlation ID
chrome.runtime.sendMessage({
  messageType: 'getPageHtmlCaptures',
  correlationId: 'conv_12345'
})
```

## Integration with Interactions

The page HTML capture module is designed to be **correlation-aware**:

1. **Link Captures to Interactions**: Other modules (e.g., news_eval) can set a correlation ID to link HTML snapshots to specific chatbot interactions
2. **Query by Correlation**: Service worker stores captures both by URL and by `correlationId` for easy retrieval
3. **Analytical Export**: When exporting or analyzing interaction data, include the corresponding page HTML snapshots from the same correlation window

### Example: Fetching Captures for an Interaction

```javascript
// Get all captures that happened during this interaction
await chrome.runtime.sendMessage({
  messageType: 'getPageHtmlCaptures',
  correlationId: interaction.interaction_id
})
```

## Performance & Privacy

- **Memory**: Default max 100 captures per URL, ~5MB per uncompressed snapshot (actual 1–2 MB for typical pages)
- **Network**: Captures are stored locally, not transmitted until explicitly requested by dependent modules
- **Cleanup**: Stale captures purged hourly to prevent unbounded memory growth
- **User Privacy**: Full page HTML is captured including any user input visible in DOM

## Tuning Guidelines

| Scenario | Config |
|----------|--------|
| **Frequent Updates** (fast typist) | `captureIntervalMs: 5000` (every 5 sec) |
| **Moderate Activity** (normal chatbot use) | `captureIntervalMs: 10000` (every 10 sec) |
| **Light Activity** (reading responses) | `captureIntervalMs: 30000` (every 30 sec) |
| **Network Constrained** | `captureIntervalMs: 60000` (every 60 sec) or disable |
| **Disabled** | `"enabled": false` in `platformConfigs.[platform]` or master `enabled: false` |

## Deployment Checklist

- [ ] Add `page_html_capture` block to `AppConfiguration` in Django admin
- [ ] Set `enabled: true` for desired platforms
- [ ] Configure `captureIntervalMs` based on expected chatbot activity
- [ ] No extension rebuild required — changes take effect within 1 alarm cycle (~1 minute)
- [ ] Monitor extension memory usage if `captureIntervalMs` is very low (<5 sec)
