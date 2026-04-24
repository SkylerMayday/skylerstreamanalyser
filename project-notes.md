# Stream Analyser — Project Notes

> **How to use this file:**
> I (Claude) search this at the start of every session.
> Update the "Current state" and "Pending" sections after each session.
> Add to "Decisions & context" when we make a non-obvious choice worth remembering.

---

## ⚠️ PRIORITY — Complete this first (next session)

### Deploy to Railway + post-deployment fixes

All code changes are complete and verified. Output files are ready to deploy.

**Deployment steps (do outside Claude):**
1. Push all output files to a GitHub repo in this structure:
   ```
   proxy.js
   package.json
   railway.toml
   public/
     index.html
     lib/
       audio-probe.js
   ```
2. Create a new Railway service pointing to the repo
3. Set env var: `ANTHROPIC_API_KEY` in Railway service settings
4. Confirm deploy succeeds and app loads at the Railway URL
5. Test: sign in, run a VOD analysis, confirm audio works + AI features work

**Post-deployment fixes (implement in next session after Railway confirmed):**

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
- **Top tabs:** Dashboard (login-gated) · Stream Analysis · Settings
- **Dashboard sub-tabs:** Channel Overview · Stream History · Pre-Stream Checklist
- **Settings sub-tabs:** Audio Analysis · AI Analysis
- **Stream Analysis results:** VOD metadata → inline-title-rating-card → benchmark-card → ai-metrics-card → feedback-list
- **Sub-tabs inside Stream Analysis results:** Analysis · Studio
- **Settings > Audio Analysis:** simple "no config needed" card + echo probe card + local upload card
- **Settings > AI Analysis:** title rating card only (no key input)

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

### Migration complete — all changes verified ✅

| Change | Status |
|---|---|
| R1: `proxy.js` rewritten as Express app | ✅ |
| R2: `/api/claude` POST route + rate limiting | ✅ |
| R3: `callClaude()` POSTs to `/api/claude` relay | ✅ |
| R4: Claude API key UI + JS fully removed | ✅ |
| R4: `isAIUnlocked()` → `return true` | ✅ |
| R4: `isAIUnlocked()` guards removed from title-rating, desc-analysis, ai-tab | ✅ |
| R5: `audio-probe.js` `getProxyUrl()` → `return ''` | ✅ |
| R5: `audio-probe.js` `fetchText` → `/proxy?url=` | ✅ |
| R5: `audio-probe.js` `fetchBytes` → `/proxy-audio?url=` | ✅ |
| R5: `isAudioUnlocked()` → `return !!(saved.user)` | ✅ |
| R5: `updatePillAudio()` proxyUrl branch removed | ✅ |
| R6: File structure — `public/index.html`, `public/lib/audio-probe.js` | ✅ |
| R7: `railway.toml` and `package.json` created | ✅ |
| R8: Proxy config card replaced with simple status card | ✅ |
| R9: `updateProxyStatus`, `restoreProxy`, proxy handlers removed | ✅ |
| F5: `#inline-title-rating-card` + auto-run poll wiring | ✅ |
| runAIMetrics function body + `#ai-metrics-card` div | ✅ |
| Description fetch uses `/users?id=` endpoint | ✅ |

### Output files — verified, ready to deploy
- `public/index.html` ✅ (5226 lines)
- `public/lib/audio-probe.js` ✅
- `proxy.js` ✅ (Express, Railway edition)
- `package.json` ✅
- `railway.toml` ✅

### Not yet done
- Railway deployment (outside Claude)
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

### Proxy URL post-migration
All proxy calls use relative URLs. `getProxyUrl()` returns `''`. `fetchText` → `/proxy?url=`. `fetchBytes` → `/proxy-audio?url=`.

### Clip scoring
Chat + audio scored independently, merged with 20s dedup. Both signals surfaced in detail panel.

### AI model
`claude-sonnet-4-6` throughout.

### Title rating
Auto-fills and auto-runs from VOD title when `runAnalysis` completes. Result polled into `#inline-title-rating-card` (polls `#title-rating-result` every 500ms, max 30s). Settings > AI Analysis keeps title rating card for manual re-runs.

### Settings tab visibility
Settings always visible — not login-gated.

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
| Apr 25 2026 | R4–R9 all applied and verified from uploaded working files. All output files produced and verified 23/23 checks. |

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
