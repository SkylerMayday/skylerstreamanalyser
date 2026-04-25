# Stream Analyser — Project Notes

> **How to use this file:**
> I (Claude) search this at the start of every session.
> Update the "Current state" and "Pending" sections after each session.
> Add to "Decisions & context" when we make a non-obvious choice worth remembering.

---

## ⚠️ PRIORITY — Complete this first (next session)

### Post-deployment fixes

| # | Item | Notes |
|---|---|---|
| P1 | `loadChannelOverview()` trigger on Dashboard entry | Currently only fires on inner-tab click. Should also fire when user first opens Dashboard tab while logged in. Add call in `showLoggedIn` or the Dashboard tab click handler. Guard with a `let overviewLoaded = false` flag. |
| P2 | Channel Description Analysis card placement | `#channel-desc-card` is inside `#channel-overview-content` which is hidden until `loadChannelOverview` populates it. Either move it outside as a standalone card, or confirm P1 fix makes it accessible in time. |

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
| `localStorage['vodDeskCreds']` | `{ clientId, accessToken, login, userId }` — no claudeKey, no proxyUrl post-migration |

### Auth model
- Twitch: implicit OAuth flow. Token stored in localStorage. `isAudioUnlocked()` = logged in.
- Claude AI: server-side key (`ANTHROPIC_API_KEY` env var). `isAIUnlocked()` = always `true`.
- History saves only for own-channel analyses (`loggedInLogin === channelName`).

### AI call convention
- All Claude calls use model `claude-sonnet-4-6`, `max_tokens` 800–900.
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
- **Stream Analysis results:** VOD metadata → inline-title-rating-card → benchmark-card → ai-metrics-card → feedback-list
- **Sub-tabs inside Stream Analysis results:** Analysis · Studio

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
| `callClaude(system, user, maxTokens)` | POSTs to `/api/claude` relay |
| `renderBenchmarkCard` | Benchmark stats card |
| `switchSubTab` / `switchStudioTab` | Tab switching + iframe management |
| `loadChannelOverview` | Followers, schedule, recent VODs |

---

## 2. Current state (as of session: 25 Apr 2026)

### All changes verified ✅

| Change | Status |
|---|---|
| R1–R9: Railway migration complete | ✅ |
| F5: `#inline-title-rating-card` + auto-run poll wiring | ✅ |
| runAIMetrics function body + `#ai-metrics-card` div | ✅ |
| Description fetch uses `/users?id=` endpoint | ✅ |
| Issue 1: Tab order — Dashboard · Stream Analysis · Settings | ✅ |
| Issue 2: Audio batch BATCH=5, 200ms delay between batches | ✅ |
| Issue 3: Stream length removed from generateFeedback + renderBenchmarkCard | ✅ |
| Issue 4+5: Settings tab hidden; Audio Analysis moved to Dashboard sub-tab | ✅ |
| Issue 4+5: AI Analysis panel removed; title-rating elements kept as hidden DOM nodes | ✅ |
| Issue 6: CCV tier card, CSS, JS (autoEstimateCCVTier, initTierSelector) all removed | ✅ |

### Output files
- `public/index.html` ✅ (5063 lines)
- `public/lib/audio-probe.js` ✅ (unchanged)
- `proxy.js` ✅ (unchanged from last session)
- `package.json` ✅ (unchanged)
- `railway.toml` ✅ (unchanged)

### Not yet done
- P1: `loadChannelOverview()` auto-trigger on Dashboard tab open
- P2: Channel Description Analysis card accessibility before overview loads

---

## 3. Decisions & context

### Hosting — Railway (new service in existing project)
Same Railway account, same project, separate service. Stays within $5/month Hobby plan.

### Claude API key — server-side
Key in Railway env var `ANTHROPIC_API_KEY`. Never sent to client. All calls relay through `POST /api/claude`. Rate limiting: 10/IP/hr in-memory, no Redis needed.

### callClaude ↔ proxy field names
`callClaude` sends `{ system, user, maxTokens }`. Proxy `/api/claude` reads `{ system, user, maxTokens }` and passes to Anthropic as `messages: [{ role: 'user', content: user }]`. Proxy returns full Anthropic response object; `callClaude` extracts text via `.content.filter(b => b.type === 'text').map(b => b.text).join('')`.

### Audio decode
Twitch VOD segments = MPEG-TS. Browser can't decode directly.
1. `proxy.js /proxy-audio` demuxes TS → ADTS/AAC (hand-written TS parser, zero extra deps)
2. `audio-probe.js` uses Web Audio API → energy curve

### Audio batch throttling
Dense scan fires 120 segments. BATCH=5 with 200ms delay between batches prevents Railway connection pool exhaustion under load. Previously BATCH=8 with 0ms delay caused intermittent failures.

### Proxy URL post-migration
All proxy calls use relative URLs. `getProxyUrl()` returns `''`. `fetchText` → `/proxy?url=`. `fetchBytes` → `/proxy-audio?url=`.

### Clip scoring
Chat + audio scored independently, merged with 20s dedup. Both signals surfaced in detail panel.

### AI model
`claude-sonnet-4-6` throughout.

### Title rating — hidden DOM elements
`#title-rating-input`, `#title-rating-btn`, `#title-rating-result`, `#title-rating-char` are kept as hidden `display:none` elements inside the Stream Analysis view. The AI Analysis panel was removed but these elements are still referenced by the auto-run polling logic in `runAnalysis`. They live in a hidden div, invisible to users.

### Settings tab — hidden not deleted
Settings tab button has `display:none`. The view and `#inner-settings-audio` shell still exist in DOM so `switchTab('settings')` doesn't throw. Content was moved to Dashboard > Audio Analysis.

### CCV tier — fully removed
Removed: HTML card, CSS rules, `autoEstimateCCVTier()` function, `initTierSelector()` IIFE, call in `showLoggedIn`. The `ccvTier` key may still exist in some users' localStorage from prior sessions but it's no longer read or written.

### Tab visibility by auth state
- Logged out: Stream Analysis only (Dashboard hidden, Settings hidden)
- Logged in: Dashboard · Stream Analysis (Settings still hidden)

---

## 4. Session log

| Date | What changed |
|---|---|
| Early sessions | Initial app: Twitch login, VOD list, chat fetch, basic clip scoring, proxy v1 |
| Mid sessions | Audio probe, proxy v2 (TS demux), dense scan, studio tabs, tile player |
| Apr 22 2026 | AI features: improvement notes, checklist synthesis, title rating (AI panel) |
| Apr 23 2026 | AI metrics card HTML + JS, runAIFeedback, Step 9, switchSubTab iframe clear, fullscreenchange, tile loader |
| Apr 24 2026 | Confirmed runAIMetrics + #ai-metrics-card present. UI restructure complete. |
| Apr 25 2026 | Railway migration decided. R1–R3 (Express proxy, /api/claude, callClaude), F5 (inline title rating) complete. |
| Apr 25 2026 | R4–R9 all applied and verified. All output files produced and verified 23/23 checks. |
| Apr 25 2026 | Issues 1–6: tab order, audio batch, stream length removal, Settings restructure, CCV tier removal. |

---

## 5. Backlog — do NOT implement until explicitly asked

### New metrics / signals
- Clip creation rate — Helix `/clips?video_id=`
- First-time chatter rate, emote-only ratio, sub/VIP/mod share
- Question detection, hype train, hate raid, lurker conversion
- Stream stability, bot presence, clip virality
- Cold open quality, stream pacing, outro quality
- Chatter growth, head-to-head comparison, follower conversion
- Discoverability/searchability audit, raid target finder, tag audit
- Optimal streaming window, highlights tracking

### Integrations needing extra OAuth scopes
- Sub count/tier — `channel:read:subscriptions`
- Bits — `bits:read`
- StreamElements, TwitchTracker, bitrate from manifests

### Infrastructure
- IndexedDB migration (KIV)
- Shareable report (KIV — more feasible post-Railway)
