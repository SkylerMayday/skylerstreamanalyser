# Stream Analyser — Project Notes

> **How to use this file:**
> I (Claude) search this at the start of every session.
> Update the "Current state" and "Pending" sections after each session.
> Add to "Decisions & context" when we make a non-obvious choice worth remembering.

---

## ⚠️ PRIORITY — Complete this first (next session)

No outstanding priority items. App is live and working. Collect user feedback before next round of fixes.

---

## 1. Architecture snapshot

### File structure (deployed)
```
proxy.js                  ← Express server (root)
package.json
railway.toml
public/
  index.html              ← the app
  lib/
    audio-probe.js
```

### Key globals / state
| Name | What it holds |
|---|---|
| `window.__activeStudioTab` | Currently visible studio tab (`'highscore'`, `'chat'`, `'audio'`, or `null`) |
| `window.__studioTabLoader` | Map of tabKey → `function(autoplay)` — set by `renderStudioClips` |
| `window.__energyCurve` | Audio energy array from the last probe, used by sparkline |
| `localStorage['vodDeskCreds']` | `{ client, token, user }` — client always persisted now, no claudeKey, no proxyUrl |

### Auth model
- Twitch: implicit OAuth flow. Token + clientId stored in localStorage. `isAudioUnlocked()` = logged in.
- Claude AI: server-side key (`ANTHROPIC_API_KEY` env var). `isAIUnlocked()` = always `true`.
- History saves only for own-channel analyses (`loggedInLogin === channelName`).
- OAuth scopes: `user:read:email channel:read:subscriptions bits:read`

### AI call convention
- All Claude calls use model `claude-sonnet-4-6`, `max_tokens` 1000.
- All expect JSON back. System prompt says "return ONLY valid JSON".
- Pattern: fire background, `.catch(e => log(..., 'warn'))` — never block UI.
- All calls go through `POST /api/claude` relay on the Express server.
- Rate limiting: 10 calls per IP per 60 minutes (in-memory Map, no Redis).
- `callClaude()` sends `{ system, user, maxTokens }`. Proxy reads the same fields.

### Tab structure
- **Top tabs (logged out):** Stream Analysis only
- **Top tabs (logged in):** Dashboard · Stream Analysis
- **Settings tab:** hidden (`display:none`) — not accessible from UI
- **Dashboard sub-tabs:** Channel Overview · Audio Analysis · Stream History · Pre-Stream Checklist
- **Dashboard > Channel Overview cards:** Follower metrics · Schedule consistency · Subscribers · Bits · Channel description analysis · Discoverability audit · Community protection
- **Stream Analysis results:** VOD metadata → inline-title-rating-card → benchmark-card → bitrate-card → ai-metrics-card → feedback-list
- **Sub-tabs inside Stream Analysis results:** Analysis · Studio
- **Studio sub-tabs:** High Score · Chat-Spike · Audio-Peak

### Key function map
| Function | Purpose |
|---|---|
| `runAnalysis(vodId)` | Master orchestrator |
| `scoreClips` / `scoreAudioClips` / `dedupClips` | Clip scoring pipeline |
| `buildAndRenderHighScoreClips` | High Score tab |
| `renderStudioClips` | Tile grid + `__studioTabLoader` registration |
| `generateFeedback` / `generateImprovementNotes` | Rule-based notes |
| `runAIImprovementNotes` / `runAIFeedback` / `runAIMetrics` | AI background steps 7/8/9 |
| `runAIChecklistSynthesis` | AI checklist for History tab |
| `runTitleRating(title, targetEl)` | Shared title rating — auto-run, Rate button, alt clicks |
| `callClaude(system, user, maxTokens)` | POSTs to `/api/claude` relay |
| `renderBenchmarkCard(meta, comments, clips)` | Benchmark stats card |
| `fetchAndRenderBitrateCard(vodId)` | HLS manifest → quality levels card |
| `fetchVodClipCount(vodId)` | Helix clip count → re-renders benchmark + feedback |
| `loadSubCount(userId, client, token)` | Subscriber count + tier proxy → Dashboard |
| `loadBits(userId, client, token)` | Bits total + leaderboard → Dashboard |
| `runDiscoverabilityAudit()` | AI audit of title/category/tags/description |
| `switchSubTab` / `switchStudioTab` | Tab switching + iframe management |
| `loadChannelOverview` | Followers, schedule, subs, bits, recent VODs |

---

## 2. Current state (as of session: 26 Apr 2026)

### All changes complete ✅

| Change | Status |
|---|---|
| Railway migration (R1–R9) | ✅ |
| Issues 1–6: tab order, audio batch, stream length, Settings restructure, CCV tier removal | ✅ |
| Audio decode fix: direct AAC first, transmux fallback | ✅ |
| Title rating: maxTokens 1000, shared function, alt clicks rate inline | ✅ |
| P1+P2: loadChannelOverview auto-fires on Dashboard open | ✅ |
| Studio tab highlight bug fixed (classList.toggle) | ✅ |
| Studio tabs clickable (click wiring was crashing due to parse-time DOM access) | ✅ |
| Sub count + tier card in Dashboard Channel Overview | ✅ |
| Bits leaderboard card in Dashboard Channel Overview | ✅ |
| Bitrate card in Stream Analysis (from HLS manifest) | ✅ |
| OAuth scopes: added `channel:read:subscriptions bits:read` | ✅ |
| Clip creation rate: Helix fetch, re-renders benchmark + feedback | ✅ |
| Cold open / outro quality in benchmark + feedback | ✅ |
| Sub/VIP/mod chat share in benchmark + feedback | ✅ |
| Stream pacing (longest dead stretch) in benchmark + feedback | ✅ |
| Discoverability audit card (AI-powered, Dashboard) | ✅ |
| Hype train optimisation advice card (Dashboard) | ✅ |
| Hate raid defence + bot removal advice card (Dashboard) | ✅ |
| CSP headers in proxy.js (allows mux.js eval + CDN) | ✅ |
| Auth fix: DEFAULT_CLIENT_ID now persisted to localStorage on sign-in | ✅ |
| Auth fix: bootstrapIfLoggedIn uses getClientId() not saved.client | ✅ |
| Stray </div> closing main early — removed | ✅ |
| Syntax fix: unescaped apostrophe in single-quoted string | ✅ |

### Output files (deployed, confirmed matching)
- `public/index.html` ✅ (5565 lines)
- `public/lib/audio-probe.js` ✅
- `proxy.js` ✅ (CSP headers added)
- `package.json` ✅ (unchanged)
- `railway.toml` ✅ (unchanged)

---

## 3. Decisions & context

### Hosting — Railway
Same Railway account, same project, separate service. Stays within $5/month Hobby plan.

### Claude API key — server-side
Key in Railway env var `ANTHROPIC_API_KEY`. Never sent to client. All calls relay through `POST /api/claude`. Rate limiting: 10/IP/hr in-memory, no Redis needed.

### Auth — DEFAULT_CLIENT_ID persistence
`DEFAULT_CLIENT_ID` is baked into the app. On first sign-in it's now always written to `localStorage['vodDeskCreds'].client` before the OAuth redirect. `bootstrapIfLoggedIn` uses `getClientId()` which falls back to `DEFAULT_CLIENT_ID` if `saved.client` is missing — covers users with stale localStorage from before this fix.

### CSP
Railway doesn't set a CSP by default but browsers enforce stricter policies in some contexts. `proxy.js` now sets an explicit CSP on all responses allowing `unsafe-eval` (mux.js), `cdn.jsdelivr.net`, Twitch domains, and `unsafe-inline` styles.

### Audio decode — direct first, transmux fallback
`proxy.js /proxy-audio` demuxes TS → ADTS/AAC server-side. `decodeSegment` tries `ctx.decodeAudioData()` directly first. Only falls back to mux.js transmux if direct decode fails.

### Audio batch throttling
BATCH=5 with 200ms delay between batches. Previously BATCH=8 with 0ms caused Railway connection pool exhaustion.

### Clip scoring
Chat + audio scored independently, merged with 20s dedup.

### AI model + token budget
`claude-sonnet-4-6` throughout. `max_tokens: 1000` for title rating and discoverability audit. Other calls 800–900.

### Title rating — shared function
`runTitleRating(title, targetEl)` used in three places: auto-run, Rate button, alt clicks. Alt clicks rate inline below current result, chainable.

### Title rating — hidden DOM elements
`#title-rating-input`, `#title-rating-btn`, `#title-rating-result`, `#title-rating-char` kept as hidden elements. No longer functionally needed but kept to avoid null-reference errors.

### Settings tab — hidden not deleted
Tab button has `display:none`. Shell still exists so `switchTab('settings')` doesn't throw.

### Sub count — points proxy for tier breakdown
`/subscriptions` returns `total` and `points`. Points ÷ subs = avg tier proxy (T1=1.0 baseline).

### Bits — all-time via leaderboard
`/bits/leaderboard?period=all` returns total + top 5 cheerers. No per-stream breakdown available.

### Bitrate card — from HLS manifest
Fetches master playlist via proxy, parses BANDWIDTH/RESOLUTION/NAME per variant. Background step after analysis.

### Clip creation rate — background Helix fetch
`fetchVodClipCount` fires after analysis completes, re-renders benchmark card and feedback list with `meta.twitchClipCount` injected.

### Discoverability audit
Fetches channel title, category, tags, description from Helix then sends to Claude. Returns score + 5 dimensions + wins/issues/actions. Re-runnable.

### Historical CCV — decided against
TwitchTracker scraping only, fragile, widens proxy attack surface. Not worth it.

### StreamElements tips — decided against
Requires separate SE OAuth flow and token management. Disproportionate complexity.

### Tab visibility by auth state
- Logged out: Stream Analysis only
- Logged in: Dashboard · Stream Analysis

### loadChannelOverview auto-trigger
`overviewLoaded` flag prevents repeated calls on every tab switch. Resets on page reload.

### Re-auth required for new scopes
Users who signed in before the scope addition need to sign out and back in once. Sub/bits cards show a friendly prompt if token predates the new scopes.

---

## 4. Session log

| Date | What changed |
|---|---|
| Early sessions | Initial app: login, VOD list, chat fetch, clip scoring, proxy v1 |
| Mid sessions | Audio probe, proxy v2 (TS demux), dense scan, studio tabs, tile player |
| Apr 22 2026 | AI features: improvement notes, checklist synthesis, title rating |
| Apr 23 2026 | AI metrics card, runAIFeedback, Step 9, iframe management, tile loader |
| Apr 24 2026 | UI restructure complete |
| Apr 25 2026 | Railway migration (R1–R9), inline title rating |
| Apr 25 2026 | Issues 1–6: tab order, audio batch, stream length, Settings, CCV tier |
| Apr 25 2026 | Audio decode fix. Title rating refactored. P1+P2 resolved. Alt clicks rate inline. |
| Apr 25 2026 | Studio tab highlight fix. Sub/bits/bitrate cards. New benchmark metrics. Discoverability + protection cards. |
| Apr 26 2026 | CSP fix (proxy.js). Auth fix (DEFAULT_CLIENT_ID persistence). Stray div fix. Apostrophe syntax fix. App confirmed live. |

---

## 5. Backlog — do NOT implement until explicitly asked

### KIV
- Head-to-head channel comparison — significant UI work
- IndexedDB migration — only matters when history gets large (current limit: 50 VODs)
- Shareable report — needs export/hosting solution

### Decided against — do not revisit unless explicitly asked
- Historical CCV via TwitchTracker — scraping only, fragile, widens proxy allowlist
- StreamElements tips/donations — separate OAuth flow, disproportionate complexity
- Emote-only ratio — requires emote registry API, fiddly
- Question detection — NLP needed, burns rate limit on 5000+ messages
- Hype train detection — requires EventSub/webhooks, not available via VOD polling
- Hate raid detection — requires real-time monitoring, not VOD analysis
- Lurker conversion — no data source
- Bot presence — external dependency (known bot lists)
- Clip virality — needs time-series polling across days
- Chatter growth / follower conversion — needs historical per-stream data we don't store
