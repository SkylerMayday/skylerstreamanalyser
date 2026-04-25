/**
 * studio.js — Stream Analyser clip scoring & studio tab module
 * =============================================================
 *
 * Extracted from index.html for cleaner separation of concerns.
 *
 * Exports (attached to window):
 *   window.scoreClips(comments, duration, audioMoments) → clips[]
 *   window.scoreAudioClips(energyCurve, duration) → clips[]
 *   window.dedupClips(audioClips, chatClips, audioCandidates) → { audioClips, chatClips }
 *   window.renderStudioClips(clips, gridId, tabKey, vodId, channelName, vodDuration)
 *   window.buildAndRenderHighScoreClips(chatClips, audioClips, vodId, channelName, vodDuration)
 *   window.switchStudioTab(name)
 *   window.runDenseAudioScan(vodId, duration, chatClips) → Promise
 *   window.__activeStudioTab   — currently visible studio tab
 *   window.__studioTabLoader   — map of tabKey → loader function
 *   window.__studioClips       — map of tabKey → clips[]
 *
 * Depends on (globals defined in index.html):
 *   $, log, escapeHTML, fmtDur, setPill, AudioProbe
 */

// ===============================================
// Clip scoring
// ===============================================
const HYPE_KEYWORDS = /\b(pog|poggers|lol|lmao|lmfao|rofl|omg|wtf|holy|insane|clutch|nice|gg|wp|hype|W|cracked|clean|nuts|no way|let'?s go|lets go|goated|goat|sick|sheesh|based|actual|literally|bro|wait what)\b/i;
const LAUGH_EMOJIS = /[😂🤣😭💀]|KEKW|LULW|OMEGALUL|PepeLaugh|LUL|KEK/g;
const HYPE_EMOTES = /PogChamp|Pog|POGGERS|WAYTOODANK|PepegaCredit|EZ|EZY|W\s*$|Clap|PogU/g;

function scoreClips(comments, duration, audioMoments) {
  if (!comments.length) return [];
  const windowSec = 30;
  const hopSec = 10;
  const windows = [];
  comments.sort((a,b) => a.t - b.t);

  const binSec = 5;
  const nBins = Math.ceil(duration / binSec);
  const bins = new Array(nBins).fill(0);
  comments.forEach(c => {
    const i = Math.floor(c.t / binSec);
    if (i >= 0 && i < nBins) bins[i]++;
  });
  const mean = bins.reduce((a,b) => a+b, 0) / bins.length || 1;
  const sd = Math.sqrt(bins.reduce((a,b) => a + (b-mean)**2, 0) / bins.length) || 1;

  for (let start = 0; start + windowSec <= duration; start += hopSec) {
    const end = start + windowSec;
    const winMsgs = comments.filter(c => c.t >= start && c.t < end);
    if (!winMsgs.length) continue;

    const startBin = Math.floor(start / binSec);
    const endBin = Math.floor(end / binSec);
    const winBinSum = bins.slice(startBin, endBin).reduce((a,b) => a+b, 0);
    const binsInWin = Math.max(1, endBin - startBin);
    const z = ((winBinSum / binsInWin) - mean) / sd;

    let laughs = 0, hype = 0, hypeEmotes = 0;
    winMsgs.forEach(m => {
      const msg = m.msg || '';
      const laughMatches = msg.match(LAUGH_EMOJIS);
      if (laughMatches) laughs += laughMatches.length;
      if (HYPE_KEYWORDS.test(msg)) hype++;
      const emoteMatches = msg.match(HYPE_EMOTES);
      if (emoteMatches) hypeEmotes += emoteMatches.length;
    });

    const uniqueUsers = new Set(winMsgs.map(m => m.user)).size;
    const velocityScore = Math.max(0, z) * 1.0;
    const excitementScore = (laughs * 0.35 + hype * 0.45 + hypeEmotes * 0.4 + uniqueUsers * 0.15) / windowSec;
    const score = velocityScore + excitementScore * 2.5;

    windows.push({ start, end, score, z, laughs, hype, hypeEmotes,
      unique: uniqueUsers, msgCount: winMsgs.length,
      sample: winMsgs.slice(0, 12), audioMoments: [], audioBoost: 0 });
  }

  windows.sort((a,b) => b.score - a.score);
  const picked = [];
  for (const w of windows) {
    if (picked.some(p => !(w.end < p.start - 20 || w.start > p.end + 20))) continue;
    picked.push(w);
    if (picked.length >= 12) break;
  }
  picked.sort((a,b) => b.score - a.score);
  return picked;
}

// Reasoning text for a clip window
function clipReason(c) {
  const parts = [];
  if (c.audioBoost > 0.5) parts.push(`<strong>audio spike</strong> (${c.audioMoments.length} peak${c.audioMoments.length>1?'s':''})`);;
  if (c.z > 2) parts.push(`chat velocity spiked <strong>${c.z.toFixed(1)}σ</strong> above baseline`);
  else if (c.z > 1) parts.push(`chat activity up <strong>${c.z.toFixed(1)}σ</strong>`);
  if (c.laughs > 5) parts.push(`${c.laughs} laugh reactions`);
  if (c.hypeEmotes > 3) parts.push(`${c.hypeEmotes} hype emotes (PogU / EZ / Clap)`);
  if (c.hype > 5) parts.push(`${c.hype} hype keywords (W / insane / clutch)`);
  if (c.unique > 15) parts.push(`<strong>${c.unique}</strong> unique commenters reacting`);
  if (!parts.length) parts.push(`${c.msgCount} messages in window`);
  return parts.join(' · ');
}

// ===============================================
// Audio clip scoring (dense scan results)
// ===============================================
// energyCurve: array of { t, rms } at ~90s intervals across the VOD
// Returns up to 15 non-overlapping windows ranked by RMS energy peak
function scoreAudioClips(energyCurve, duration) {
  if (!energyCurve || energyCurve.length < 3) return [];
  const windowSec = 30;

  // ── Normalise against the 95th-percentile RMS ──────────────────────────────
  // Raw RMS is useless across streams: a quiet streamer at 0.003 peak and a loud
  // one at 0.4 peak should produce identical excitement curves. Dividing by the
  // 95th percentile (not max, which is sensitive to a single spike) maps every
  // stream's energy curve into the same [0..~1] range before z-scoring.
  const sorted = [...energyCurve.map(p => p.rms)].sort((a, b) => a - b);
  const p95idx = Math.floor(sorted.length * 0.95);
  const p95 = sorted[p95idx] || sorted[sorted.length - 1] || 1e-6;
  // Guard: if the whole stream is near-silent (p95 < noise floor), normalise
  // anyway — relative peaks still matter even in a whisper-quiet VOD.
  const normCurve = energyCurve.map(p => ({ t: p.t, rms: p.rms / p95 }));

  // Build a quick lookup: average normalised RMS across points in a window
  function normRmsInWindow(start, end) {
    const pts = normCurve.filter(p => p.t >= start && p.t < end);
    if (!pts.length) return 0;
    return pts.reduce((a, p) => a + p.rms, 0) / pts.length;
  }

  // Z-score on the normalised curve — captures relative spikes regardless of
  // absolute volume level
  const normValues = normCurve.map(p => p.rms);
  const mean = normValues.reduce((a, b) => a + b, 0) / normValues.length;
  const sd = Math.sqrt(normValues.reduce((a, b) => a + (b - mean) ** 2, 0) / normValues.length) || 1;

  // Candidate windows: centre each sample point in a 30s window
  const candidates = [];
  normCurve.forEach(pt => {
    const start = Math.max(0, pt.t - windowSec / 2);
    const end = Math.min(duration, start + windowSec);
    const avgNormRms = normRmsInWindow(start, end);
    const z = (avgNormRms - mean) / sd;
    if (z > 0.5) { // meaningfully above this stream's own baseline
      candidates.push({ start, end, score: z, z, rms: avgNormRms });
    }
  });

  // Non-max suppression: no overlapping windows within 20s
  candidates.sort((a, b) => b.score - a.score);
  const picked = [];
  for (const w of candidates) {
    if (picked.some(p => !(w.end < p.start - 20 || w.start > p.end + 20))) continue;
    picked.push(w);
    if (picked.length >= 20) break; // keep extras so dedup has room
  }
  picked.sort((a, b) => b.score - a.score);
  return picked;
}

// Dedup: remove audio clips whose start is within 45s of any chat clip
// Returns [dedupedAudio, dedupedChat] — chat clips are untouched,
// audio clips that overlap are replaced from the candidate pool if available
function dedupClips(audioClips, chatClips, audioCandidates) {
  const OVERLAP_SEC = 45;
  function overlaps(a, b) {
    return Math.abs(a.start - b.start) < OVERLAP_SEC;
  }

  const usedAudio = [];
  const allAudioSorted = [...audioClips]; // already ranked by score

  for (const ac of allAudioSorted) {
    const clashesChat = chatClips.some(cc => overlaps(ac, cc));
    const clashesAudio = usedAudio.some(ua => overlaps(ac, ua));
    if (!clashesChat && !clashesAudio) {
      usedAudio.push(ac);
    }
    if (usedAudio.length >= 15) break;
  }

  // Chat clips: always keep top 15, deduplicated against themselves only
  const usedChat = [];
  for (const cc of chatClips) {
    if (!usedChat.some(uc => overlaps(cc, uc))) {
      usedChat.push(cc);
    }
    if (usedChat.length >= 15) break;
  }

  return { audioClips: usedAudio, chatClips: usedChat };
}

// ===============================================
// Benchmark reference card
// ===============================================
// Benchmark reference card
// ===============================================
// Static industry reference values grounded in publicly available Twitch data.
// Sources: Twitch Insights blog (archived), StreamElements State of the Stream
// reports (2022-2024), TwitchTracker aggregates, and widely-cited streamer
// guides from Devin Nash / Zack Larson / Gaming Careers.
//
// These are *ranges observed across streamers*, not aspirational targets.
// Shown as a compact "your stream vs typical" table above the feedback list.

function renderBenchmarkCard(meta, comments, clips) {
  const dur = meta.duration;
  const cpm = dur > 0 ? comments.length / (dur / 60) : 0;

  // Dead-air: % of 1-min buckets with fewer than 2 messages
  const binSec = 60;
  const nBins = Math.ceil(dur / binSec);
  const bins = new Array(nBins).fill(0);
  comments.forEach(c => { const i = Math.floor(c.t / binSec); if (i >= 0 && i < nBins) bins[i]++; });
  const deadPct = nBins > 0 ? (bins.filter(b => b < 2).length / nBins) * 100 : 0;

  const unique = new Set(comments.map(c => c.user)).size;
  const uniqueRatio = comments.length > 0 ? unique / comments.length : 0;

  // Peak-to-mean ratio: how spikey is the chat?
  const mean = bins.reduce((a, b) => a + b, 0) / (nBins || 1);
  const peak = Math.max(...bins, 0);
  const peakMeanRatio = mean > 0 ? peak / mean : 0;

  // ---- Reference table rows ----
  // Each row: [metric label, your value (formatted), status, ranges text]
  function durStatus(s) {
    if (s < 30 * 60)   return 'warn';
    if (s > 8 * 3600)  return 'warn';
    if (s >= 90 * 60 && s <= 4 * 3600) return 'ok';
    return 'dim';
  }
  function cpmStatus(v) {
    if (v < 1)   return 'bad';
    if (v < 3)   return 'warn';
    if (v >= 5)  return 'ok';
    return 'dim';
  }
  function deadStatus(v) {
    if (v > 50) return 'bad';
    if (v > 25) return 'warn';
    if (v < 15) return 'ok';
    return 'dim';
  }
  function uniqueRatioStatus(v) {
    if (v < 0.25) return 'warn';
    if (v >= 0.45) return 'ok';
    return 'dim';
  }
  function peakStatus(v) {
    if (v < 2)  return 'warn'; // flat — no spikes
    if (v > 12) return 'warn'; // one huge spike, flat everywhere else
    if (v >= 3 && v <= 8) return 'ok';
    return 'dim';
  }

  const rows = [
    {
      label: 'Chat velocity',
      value: cpm.toFixed(1) + ' msg/min',
      status: cpmStatus(cpm),
      ranges: '< 1 quiet · 1–3 emerging · 3–10 active · 10+ engaged',
      note: 'Median for sub-500 CCV channels: 2–4 msg/min. Top 10% of small streamers: 8+.',
    },
    {
      label: 'Dead-air minutes',
      value: deadPct.toFixed(0) + '%',
      status: deadStatus(deadPct),
      ranges: '< 15% excellent · 15–25% normal · 25–50% notable · 50%+ problematic',
      note: 'Minutes with < 2 messages. VOD retention drops sharply through quiet stretches.',
    },
    {
      label: 'Unique / total chatters',
      value: (uniqueRatio * 100).toFixed(0) + '%',
      status: uniqueRatioStatus(uniqueRatio),
      ranges: '< 25% spammy/bot-heavy · 25–45% typical · 45%+ organic',
      note: 'Low ratio suggests a few users dominating chat or bot activity.',
    },
    {
      label: 'Chat spike ratio',
      value: peakMeanRatio.toFixed(1) + '× peak/mean',
      status: peakStatus(peakMeanRatio),
      ranges: '< 2× flat · 3–8× healthy variation · > 12× one-event stream',
      note: 'Healthy streams have recurring spikes (moments). A single huge spike with flat elsewhere means one viral moment and little else.',
    },
    {
      label: 'Clip-worthy moments',
      value: clips.length + ' found',
      status: clips.length >= 5 ? 'ok' : clips.length >= 2 ? 'dim' : 'warn',
      ranges: '0–1 sparse · 2–4 moderate · 5+ rich',
      note: 'Based on chat velocity + hype keyword scoring. Rough proxy — audio peaks included when proxy is active.',
    },
  ];

  const rowsHTML = rows.map(r => `
    <tr>
      <td>${escapeHTML(r.label)}</td>
      <td title="${escapeHTML(r.note)}">${escapeHTML(r.ranges)}</td>
      <td><span class="bench-val ${r.status}">${escapeHTML(r.value)}</span></td>
    </tr>
  `).join('');

  return `
    <div class="bench-card">
      <div class="bench-card-head">Your stream vs. typical ranges</div>
      <table class="bench-table">
        <thead>
          <tr>
            <th>Metric</th>
            <th>Typical range</th>
            <th style="text-align:right;">Your stream</th>
          </tr>
        </thead>
        <tbody>${rowsHTML}</tbody>
      </table>
      <div style="margin-top: 8px; font-size: 11px; color: var(--ink-faint); line-height: 1.5;">
        Ranges based on StreamElements State of the Stream reports (2022–2024) and TwitchTracker aggregates for sub-1000 CCV channels. Hover a range for context. Not a guarantee — every community is different.
      </div>
    </div>
  `;
}


function generateFeedback(meta, comments, clips, audio) {
  const fb = [];
  const dur = meta.duration;
  const cpm = comments.length / (dur/60);

  // Chat velocity
  if (cpm < 2) fb.push(['warn', `Chat velocity was <strong>${cpm.toFixed(1)} msg/min</strong> — quiet chat. Consider more direct chat engagement: ask questions, read messages aloud, use chat polls.`]);
  else if (cpm > 20) fb.push(['good', `Excellent chat engagement at <strong>${cpm.toFixed(1)} msg/min</strong>. This is the kind of density that creates the "everyone's talking at once" energy on VODs.`]);
  else fb.push(['info', `Chat velocity: <strong>${cpm.toFixed(1)} msg/min</strong>. Healthy but room to grow.`]);

  // Dead-air analysis
  const binSec = 60;
  const nBins = Math.ceil(dur / binSec);
  const bins = new Array(nBins).fill(0);
  comments.forEach(c => { const i = Math.floor(c.t/binSec); if (i>=0 && i<nBins) bins[i]++; });
  const dead = bins.filter(b => b < 2).length;
  const deadPct = (dead / nBins) * 100;
  if (deadPct > 40) fb.push(['warn', `<strong>${deadPct.toFixed(0)}%</strong> of your stream minutes had fewer than 2 chat messages. That's a lot of quiet stretches — the VOD won't retain casual viewers through those.`]);
  else if (deadPct < 10) fb.push(['good', `Almost every minute had active chat (only <strong>${deadPct.toFixed(0)}%</strong> quiet). Great consistency.`]);

  // Peak moment density
  if (clips.length) {
    const top = clips[0];
    fb.push(['info', `Your peak moment hit at <strong>${fmtDur(top.start)}</strong>. See the Clips section — this is your first priority for social media.`]);
    if (clips.length < 3) fb.push(['warn', `Only ${clips.length} clearly clip-worthy moment${clips.length===1?'':'s'} detected. If you want to feed your social channels regularly, aim for more hype beats — try segments that prompt reactions (reveals, reveals, challenges, audience interaction).`]);
    else fb.push(['good', `<strong>${clips.length}</strong> clip-worthy moments — enough to spread across a week of social posts.`]);
  } else fb.push(['warn', `No standout clip-worthy moments detected. Chat engagement was flat throughout — consider hooks, segments, or interactive moments next time.`]);

  // Audio
  if (audio && !audio.blocked) {
    const echoSamples = audio.results.filter(r => r.echo);
    if (echoSamples.length >= 3) {
      fb.push(['bad', `<strong>Echo detected</strong> in ${echoSamples.length}/${audio.results.length} audio samples — likely audio routing problem. Mic may be picking up speakers, or you have desktop audio routed through two sources. See the Ear Test section.`]);
    } else if (echoSamples.length > 0) {
      fb.push(['warn', `Possible echo in <strong>${echoSamples.length}/${audio.results.length}</strong> samples — not definitive, could be music or in-game echo effects. Worth spot-checking.`]);
    } else {
      fb.push(['good', `Clean audio: no echo detected across ${audio.results.length} sampled segments.`]);
    }

    // Loudness & clipping — runs on the same decoded probe buffers
    if (audio.loudness) {
      const L = audio.loudness;

      // Clipping is the most critical — distorted audio can't be fixed in post
      if (L.clippingPct > 0.5) {
        fb.push(['bad', `<strong>Audio is clipping</strong> — ${L.clippingPct.toFixed(2)}% of samples are at digital full-scale (peak ${L.peakDbFS.toFixed(1)} dBFS). This is distortion that can't be fixed after recording. Lower your mic gain or add a limiter (OBS: Filters → Limiter at -1 dB) so peaks don't hit the ceiling.`]);
      } else if (L.clippingPct > 0.05) {
        fb.push(['warn', `Occasional clipping detected (${L.clippingPct.toFixed(2)}% of samples, peak ${L.peakDbFS.toFixed(1)} dBFS). Not pervasive but worth pulling your mic gain down 2–3 dB or adding an OBS Limiter for safety.`]);
      } else if (L.peakDbFS > -1) {
        // Very close to but not quite hitting full scale — pre-clipping warning
        fb.push(['warn', `Peak level reached <strong>${L.peakDbFS.toFixed(1)} dBFS</strong> — uncomfortably close to digital clipping. A single louder laugh or bass hit will distort. Aim for peaks around -3 to -6 dBFS.`]);
      }

      // Overall mix loudness. -14 to -16 dBFS is the sweet spot for voice-forward
      // streaming content; below -22 means viewers will crank system volume and
      // then get blasted when they switch tabs.
      if (L.meanDbFS < -28 && L.meanDbFS > -100) {
        fb.push(['warn', `Mix is <strong>quiet overall</strong> (average ${L.meanDbFS.toFixed(1)} dBFS). Viewers will crank their system volume to hear you, then get blasted switching to other content. Target average loudness closer to -16 dBFS for voice-forward streams.`]);
      } else if (L.meanDbFS >= -18 && L.meanDbFS < -12) {
        fb.push(['good', `Mix loudness <strong>${L.meanDbFS.toFixed(1)} dBFS</strong> is in the sweet spot for streaming voice content.`]);
      }

      // Near-silent stretches. Different signal than dead-air chat — this is
      // audio, not chat, so it catches "streamer muted" or "long pauses" even
      // when chat is active.
      if (L.quietPct > 20) {
        fb.push(['warn', `<strong>${L.quietPct.toFixed(0)}%</strong> of probed audio was near-silent (below -50 dBFS). Either mic was muted, gain is too low, or there were long dead-air stretches. Check that your mic is properly active throughout.`]);
      }
    }
  }

  return fb;
}

// ===============================================
// Render clips + captions
// ===============================================
function renderClips(clips, listId, vodId, channelName, vodDuration) {
  const listEl = document.getElementById(listId);
  if (!listEl) return;
  if (!clips.length) {
    listEl.innerHTML = '<div style="padding:20px 0; color:var(--ink-faint); font-size:14px;">No moments found for this section.</div>';
    return;
  }
  const parentDomain = window.location.hostname || 'localhost';

  // Namespace clip state by listId to avoid collisions between the two lists
  if (!window.__clipState) window.__clipState = new Map();

  listEl.innerHTML = clips.map((c, i) => {
    const stateKey = listId + '-' + i;
    const start = Math.floor(c.start);
    const end = Math.ceil(c.end);
    window.__clipState.set(stateKey, {
      start, end,
      captionsText: '',
      vodId,
      channelName,
      vodDuration
    });
    const sampleHTML = c.sample.map(m => `<div><span class="user">${escapeHTML(m.user)}:</span> ${escapeHTML(m.msg).slice(0,120)}</div>`).join('');
    const clipId = listId + '-' + i;
    return `
      <div class="clip-item" data-idx="${i}" data-clip-id="${clipId}" data-list-id="${listId}">
        <div class="clip-head">
          <span class="clip-rank">№ ${String(i+1).padStart(2,'0')}</span>
          <div style="flex:1;">
            <div class="clip-title-row">
              <span class="clip-timestamp">${fmtDur(c.start)}</span>
              <span class="clip-duration">${Math.round(c.end - c.start)}s window</span>
              ${c.audioBoost > 0.5 ? `<span class="clip-source-tag audio" title="This clip rode a measured audio energy spike — the proxy-enabled audio probe boosted its rank">🔊 audio peak${c.audioMoments.length > 1 ? ` ×${c.audioMoments.length}` : ''}</span>` : ''}
              ${c.z > 1.5 ? `<span class="clip-source-tag chat" title="Chat velocity z-score — how far this window exceeded the stream's baseline message rate">💬 chat spike</span>` : ''}
              <span class="clip-score">score ${c.score.toFixed(2)}</span>
            </div>
            <div class="clip-reasons">${clipReason(c)}</div>
          </div>
        </div>
        <div class="clip-chat-sample">${sampleHTML || '<em>No sample</em>'}</div>

        <div class="clip-actions">
          <a href="https://www.twitch.tv/videos/${vodId}?t=${Math.floor(c.start/3600)}h${Math.floor(c.start%3600/60)}m${Math.floor(c.start%60)}s" target="_blank" style="text-decoration:none;">
            <button class="ghost small" title="Open VOD at this timestamp in Twitch">▶ Open at ${fmtDur(c.start)}</button>
          </a>
          <button class="primary" style="padding: 9px 16px;" data-open-editor="${clipId}">Preview ▸</button>
        </div>

        <div class="clip-editor" id="editor-${clipId}">
          <div class="clip-preview-wrapper" id="preview-${clipId}">
            <iframe
              title="VOD preview at ${fmtDur(start)}"
              allowfullscreen="true"
              scrolling="no"
              data-clip-idx="${i}"
              src="">
            </iframe>
          </div>

          <div class="timeline-row" style="margin-top: 12px;">
            <span class="timeline-label">Start</span>
            <div class="timeline-track" data-timeline="${clipId}">
              <div class="timeline-fill"></div>
              <div class="timeline-handle start" data-handle="start"></div>
              <div class="timeline-handle end" data-handle="end"></div>
            </div>
            <span class="timeline-value" id="end-value-${clipId}">${fmtDur(end)}</span>
          </div>
          <div class="timeline-row">
            <span class="timeline-value" id="start-value-${clipId}">${fmtDur(start)}</span>
            <div class="timeline-hint">
              Drag handles to fine-tune · Twitch clips cap at 60s
              <button class="ghost small" id="reload-preview-${clipId}" style="display:none; margin-left: 10px; padding: 3px 8px; font-size: 9px;">↻ Reload at new start</button>
            </div>
            <span class="timeline-value" id="dur-value-${clipId}">${end - start}s</span>
          </div>
        </div>
      </div>
    `;
  }).join('');

  // Wire editor open/close (scoped to this list)
  function openEditorById(clipId) {
    // Close any other open editor in the same list
    listEl.querySelectorAll('.clip-editor.open').forEach(ed => {
      const otherId = ed.closest('.clip-item').dataset.clipId;
      if (otherId !== clipId) {
        ed.classList.remove('open');
        const iframe = ed.querySelector('iframe');
        if (iframe) iframe.src = '';
        const btn = listEl.querySelector(`button[data-open-editor="${otherId}"]`);
        if (btn) btn.textContent = 'Preview ▸';
      }
    });
    const editor = document.getElementById('editor-' + clipId);
    if (!editor) return;
    editor.classList.add('open');
    loadClipPreview(clipId);
    initTimeline(clipId);
    const btn = listEl.querySelector(`button[data-open-editor="${clipId}"]`);
    if (btn) btn.textContent = '◾ Close preview';
  }

  function closeEditorById(clipId) {
    const editor = document.getElementById('editor-' + clipId);
    if (!editor) return;
    editor.classList.remove('open');
    const iframe = editor.querySelector('iframe');
    if (iframe) iframe.src = '';
    const btn = listEl.querySelector(`button[data-open-editor="${clipId}"]`);
    if (btn) btn.textContent = 'Preview ▸';
  }

  listEl.querySelectorAll('button[data-open-editor]').forEach(btn => {
    btn.addEventListener('click', () => {
      const clipId = btn.dataset.openEditor;
      const editor = document.getElementById('editor-' + clipId);
      if (editor && editor.classList.contains('open')) {
        closeEditorById(clipId);
      } else {
        openEditorById(clipId);
      }
    });
  });

  // Auto-open first editor on render
  if (clips.length > 0) {
    const firstClipId = listId + '-0';
    setTimeout(() => openEditorById(firstClipId), 120);
  }

}

// Load the Twitch player iframe for a clip based on current state.start
function loadClipPreview(clipId) {
  const state = window.__clipState.get(clipId);
  if (!state) return;
  const parentDomain = window.location.hostname || 'localhost';
  const t = state.start;
  const hrs = Math.floor(t/3600);
  const mins = Math.floor(t%3600/60);
  const secs = t%60;
  const src = `https://player.twitch.tv/?video=v${state.vodId}&parent=${parentDomain}&time=${hrs}h${mins}m${secs}s&autoplay=false`;
  const wrapper = document.getElementById('preview-' + clipId);
  if (!wrapper) return;
  const iframe = wrapper.querySelector('iframe');
  if (iframe && iframe.src !== src) iframe.src = src;
  state.previewedStart = t;
}

// Timeline interaction: draggable handles
function initTimeline(clipId) {
  const track = document.querySelector(`[data-timeline="${clipId}"]`);
  if (!track || track.__initialized) return;
  track.__initialized = true;
  const state = window.__clipState.get(clipId);
  const vodDur = state.vodDuration;
  // Zoom the timeline to a window around the clip: [clipStart - 30s, clipEnd + 60s]
  const viewStart = Math.max(0, state.start - 30);
  const viewEnd = Math.min(vodDur, state.end + 60);
  const viewRange = viewEnd - viewStart;
  state.viewStart = viewStart;
  state.viewEnd = viewEnd;

  const fill = track.querySelector('.timeline-fill');
  const handleStart = track.querySelector('.timeline-handle.start');
  const handleEnd = track.querySelector('.timeline-handle.end');

  function timeToPct(t) {
    return Math.max(0, Math.min(100, ((t - viewStart) / viewRange) * 100));
  }
  function pctToTime(pct) {
    return viewStart + (pct / 100) * viewRange;
  }

  function render() {
    const sPct = timeToPct(state.start);
    const ePct = timeToPct(state.end);
    handleStart.style.left = sPct + '%';
    handleEnd.style.left = ePct + '%';
    fill.style.left = sPct + '%';
    fill.style.width = (ePct - sPct) + '%';
    document.getElementById('start-value-' + clipId).textContent = fmtDur(state.start);
    document.getElementById('end-value-' + clipId).textContent = fmtDur(state.end);
    document.getElementById('dur-value-' + clipId).textContent = Math.round(state.end - state.start) + 's';
    const reloadBtn = document.getElementById('reload-preview-' + clipId);
    if (reloadBtn && state.previewedStart !== state.start) {
      reloadBtn.style.display = '';
    }
  }
  render();

  // Debounced preview reload after drag ends
  let reloadTimer = null;
  function scheduleReload() {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      loadClipPreview(clipId);
      const reloadBtn = document.getElementById('reload-preview-' + clipId);
      if (reloadBtn) reloadBtn.style.display = 'none';
    }, 600);
  }

  let dragging = null;
  function startDrag(handleName, ev) {
    ev.preventDefault();
    dragging = handleName;
    const onMove = (e) => {
      const rect = track.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const pct = ((clientX - rect.left) / rect.width) * 100;
      const t = Math.round(pctToTime(pct));
      if (dragging === 'start') {
        state.start = Math.max(0, Math.min(t, state.end - 2));
      } else {
        // Cap clip duration at 60s (Twitch limit)
        state.end = Math.min(vodDur, Math.max(t, state.start + 2), state.start + 60);
      }
      render();
    };
    const onUp = () => {
      dragging = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onUp);
      // Only reload preview when user stops dragging, and only if start moved
      if (state.start !== state.previewedStart) {
        scheduleReload();
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onUp);
  }
  handleStart.addEventListener('mousedown', (e) => startDrag('start', e));
  handleStart.addEventListener('touchstart', (e) => startDrag('start', e), { passive: false });
  handleEnd.addEventListener('mousedown', (e) => startDrag('end', e));
  handleEnd.addEventListener('touchstart', (e) => startDrag('end', e), { passive: false });

  // Manual reload button
  const reloadBtn = document.getElementById('reload-preview-' + clipId);
  if (reloadBtn) {
    reloadBtn.addEventListener('click', () => {
      loadClipPreview(clipId);
      reloadBtn.style.display = 'none';
    });
  }
}

// Confirm clip: produce the Twitch clip URL and show handoff tiles

// ===============================================

// File upload fallback for audio analysis
$('#audio-upload').addEventListener('change', async (ev) => {
  const file = ev.target.files && ev.target.files[0];
  if (!file) return;
  // Capture file metadata immediately — the File object reference can go stale
  const fileName = file.name;
  const fileSize = file.size;
  const fileSizeMB = (fileSize / 1024 / 1024).toFixed(1);
  log(`Reading ${fileName} (${fileSizeMB} MB)…`);

  // Show visible progress in the audio-results card so user doesn't have to
  // open the debug log drawer to know what's happening. The previous version
  // logged silently and looked dead if decode took 30+ seconds.
  const resultsCard = $('#audio-results-card');
  const resultsEl = $('#audio-results');
  resultsCard.style.display = '';
  resultsEl.innerHTML = `
    <div class="notice info">
      <strong>Analysing upload:</strong> ${escapeHTML(fileName)} (${fileSizeMB} MB)<br>
      <span id="upload-status">Reading file into memory…</span>
    </div>
  `;
  const setUploadStatus = (msg) => {
    const el = document.getElementById('upload-status');
    if (el) el.textContent = msg;
  };

  // Warn about huge files
  if (fileSize > 2 * 1024 * 1024 * 1024) {
    log(`File is ${fileSizeMB} MB. Browsers may fail to decode files over 2 GB. Consider using a shorter recording.`, 'warn');
  }

  let arrayBuffer;
  try {
    // Try the modern File.arrayBuffer() API first — it's more reliable in
    // recent Chrome than FileReader for large files. FileReader can intermittently
    // fail with "a reference to a file was acquired" errors on Chrome when the
    // file is on OneDrive, external drives, or has antivirus interference.
    // If the modern API fails for any reason, fall back to FileReader.
    try {
      arrayBuffer = await file.arrayBuffer();
    } catch (primaryErr) {
      log(`Primary read failed (${primaryErr.message}), trying FileReader fallback…`, 'warn');
      arrayBuffer = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('FileReader: ' + (reader.error?.message || 'unknown error')));
        reader.readAsArrayBuffer(file);
      });
    }
    log(`Read ${(arrayBuffer.byteLength / 1024 / 1024).toFixed(1)} MB into memory.`, 'ok');
    setUploadStatus(`Read ${(arrayBuffer.byteLength / 1024 / 1024).toFixed(1)} MB. Decoding audio (this can take 30–60s for long recordings)…`);
  } catch (e) {
    log('Upload read failed: ' + e.message, 'err');
    // Give the user actionable help rather than just the raw error.
    let help;
    // Oversize file is the most common cause of this error with multi-GB files.
    // Check size first so we give the right advice for the right failure mode.
    if (fileSize > 1.8 * 1024 * 1024 * 1024) {
      help = `
        <strong>File is too large for the browser to read (${fileSizeMB} MB).</strong> Chrome has a hard ~2 GB limit on single memory allocations. Extract just the audio track first — it's fast, lossless, and produces a file about 10% the size:
        <div style="margin-top: 8px; padding: 10px 12px; background: var(--ink); color: #86efac; border-radius: var(--r-sm); font-family: var(--mono); font-size: 12px; overflow-x: auto;">
          ffmpeg -i "your-recording.mp4" -vn -c:a copy audio.m4a
        </div>
        Then upload <code>audio.m4a</code> instead.
      `;
    } else if (e.message.includes('permission') || e.message.includes('reference to a file')) {
      help = `
        <strong>The browser lost access to the file during read.</strong> This usually means one of:
        <ul style="margin: 8px 0 0 20px;">
          <li>The file is on OneDrive, Google Drive, or Dropbox and the cloud sync briefly unloaded it. Try copying it to a regular folder (Desktop or Documents) and uploading from there.</li>
          <li>Antivirus software is scanning the file mid-read. Try again in a few seconds.</li>
          <li>The file is on an external drive that went to sleep. Open it in another app first to wake the drive, then retry.</li>
        </ul>
      `;
    } else {
      help = `Error: ${escapeHTML(e.message)}`;
    }
    resultsEl.innerHTML = `<div class="notice warn"><strong>Upload failed:</strong> ${help}</div>`;
    ev.target.value = '';
    return;
  }

  // Reset the input now that we have the bytes — prevents any further issues
  ev.target.value = '';

  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    log('Decoding audio… (this can take 30-60s for long recordings)');
    const buf = await ctx.decodeAudioData(arrayBuffer);
    const dur = buf.duration;
    log(`Decoded ${fmtDur(dur)}. Probing 15 samples across file…`, 'ok');
    setUploadStatus(`Decoded ${fmtDur(dur)}. Analysing…`);
    const ch = buf.getChannelData(0);
    const N = 15;
    const results = [];
    for (let i = 0; i < N; i++) {
      const offsetSec = (dur / (N + 1)) * (i + 1);
      const sampleStart = Math.floor(offsetSec * buf.sampleRate);
      const sampleLen = Math.floor(10 * buf.sampleRate);
      const slice = ch.subarray(sampleStart, Math.min(ch.length, sampleStart + sampleLen));
      const r = AudioProbe.detectEcho(slice, buf.sampleRate);
      results.push({ offset: offsetSec, ...r });
    }
    ctx.close();
    // Compute loudness from the whole decoded buffer — more accurate than the
    // stream probe since this is the pre-encode original audio.
    let loudness = null;
    try {
      loudness = AudioProbe.computeLoudnessStats([{ offset: 0, buffer: buf }]);
    } catch (e) {
      log('Loudness computation on upload failed: ' + e.message, 'warn');
    }
    // Wrap the render call so rendering errors surface visibly. Previously a
    // template-literal error in renderAudio (e.g. renderLoudnessPanel throwing)
    // would be caught by the outer catch and mislabeled as a decode error.
    try {
      log(`Calling renderAudio with ${results.length} results, loudness=${loudness ? 'yes' : 'no'}`);
      AudioProbe.renderAudio({ blocked: false, results, decoded: N, decodeFails: 0, loudness });
      log('renderAudio returned, checking DOM…', 'ok');
      // Verify the DOM actually updated — if innerHTML silently failed, we want to know.
      const check = document.getElementById('audio-results');
      if (check && check.innerHTML.includes('Analysing upload')) {
        log('WARNING: DOM still shows "Analysing upload" after renderAudio — render did not take effect.', 'err');
        // Force-clear and render a fallback so user sees *something*.
        check.innerHTML = `
          <div class="notice warn"><strong>Render bug:</strong> analysis completed but UI didn't update. Data below:</div>
          <pre style="padding: 12px; background: var(--surface-2); border-radius: var(--r-sm); font-size: 11px; overflow-x: auto;">${escapeHTML(JSON.stringify({
            decoded: N,
            echoes: results.filter(x => x.echo).length,
            loudness: loudness
          }, null, 2))}</pre>
        `;
      }
    } catch (renderErr) {
      log('renderAudio threw: ' + renderErr.message, 'err');
      const check = document.getElementById('audio-results');
      if (check) {
        check.innerHTML = `<div class="notice warn"><strong>Render error:</strong> ${escapeHTML(renderErr.message)}<br><br>Raw data:<pre style="font-size:11px; margin-top: 8px;">${escapeHTML(JSON.stringify({
          decoded: N,
          echoes: results.filter(x => x.echo).length,
          loudness: loudness
        }, null, 2))}</pre></div>`;
      }
    }
    setPill('pill-audio', 'Audio probe · done (upload)', 'ok');
    log('Upload analysis complete.', 'ok');
  } catch (e) {
    ctx.close();
    let msg = e.message || 'decode error';
    let userMsg;
    if (msg.includes('Unable to decode') || msg.includes('EncodingError') || msg.includes('decode')) {
      userMsg = `Browser could not decode this file format. Chrome/Edge reliably handle <strong>MP3, M4A, WAV, and MP4 (H.264 + AAC)</strong>. For OBS recordings, try setting Output → Recording → Format = <code>mp4</code> or re-encoding with <code>ffmpeg -i yourfile.mkv -c:a copy output.m4a</code> to extract just the audio.`;
    } else if (msg.includes('out of memory') || msg.includes('allocation')) {
      userMsg = `File too large to decode in memory. Try a shorter recording (under 30 minutes is a safe ceiling on most browsers).`;
    } else {
      userMsg = `Decode failed: ${escapeHTML(msg)}`;
    }
    log('Upload decode failed: ' + msg, 'err');
    resultsEl.innerHTML = `<div class="notice warn"><strong>Couldn't analyse this file.</strong><br>${userMsg}</div>`;
  }
});

// ===============================================
// Dense audio scan (background, ~120 samples)
// ===============================================
async function runDenseAudioScan(vodId, duration, chatClips) {
  log('Dense audio scan starting (~120 segments)…');
  $('#audio-clips-intro').innerHTML = '<em style="color:var(--ink-faint)">Scanning audio… this runs in the background.</em>';

  try {
    const masterUrl = await AudioProbe.getVODPlaylistURL(vodId);
    const master = await AudioProbe.fetchText(masterUrl);
    const variants = AudioProbe.parseMasterPlaylist(master);
    if (!variants.length) throw new Error('No variants');
    variants.sort((a, b) => a.bandwidth - b.bandwidth);
    const mediaPlaylist = await AudioProbe.fetchText(variants[0].uri);
    const segs = AudioProbe.parseMediaPlaylist(mediaPlaylist, variants[0].uri);
    if (!segs.length) throw new Error('No segments');

    // ~120 evenly-spaced samples (one every ~90s for a 3h VOD)
    const targetSamples = Math.min(120, segs.length);
    const stride = Math.max(1, Math.floor(segs.length / targetSamples));
    const sampled = [];
    for (let i = 0; i < segs.length && sampled.length < targetSamples; i += stride) {
      sampled.push({ seg: segs[i], idx: i });
    }

    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const energyCurve = [];
    let done = 0;

    // Fetch in batches of 5 to avoid flooding the proxy (Railway drops requests under heavy load)
    const BATCH = 5;
    for (let b = 0; b < sampled.length; b += BATCH) {
      const batch = sampled.slice(b, b + BATCH);
      await Promise.all(batch.map(async ({ seg, idx }) => {
        try {
          const offset = segs.slice(0, idx).reduce((a, s) => a + s.duration, 0);
          const bytes = await AudioProbe.fetchBytes(seg.uri);
          const buf = await AudioProbe.decodeSegment(ctx, bytes);
          // Compute RMS energy for this segment
          const ch = buf.getChannelData(0);
          let sum = 0;
          for (let j = 0; j < ch.length; j++) sum += ch[j] * ch[j];
          const rms = Math.sqrt(sum / ch.length);
          energyCurve.push({ t: offset, rms });
        } catch (e) {
          // Skip failed segments silently
        }
        done++;
      }));
      const pct = Math.round((done / sampled.length) * 100);
      $('#audio-clips-intro').innerHTML =
        `<em style="color:var(--ink-faint)">Scanning audio… ${pct}% (${done}/${sampled.length} segments)</em>`;
      // Throttle between batches: 200ms gives Railway connection pool time to recover
      await new Promise(r => setTimeout(r, 200));
    }
    ctx.close();

    if (energyCurve.length < 5) throw new Error('Too few segments decoded');
    energyCurve.sort((a, b) => a.t - b.t);
    // Stash for use in audio clip detail sparklines
    window.__energyCurve = energyCurve;

    // Score audio clips
    const audioCandidates = scoreAudioClips(energyCurve, duration);

    // Dedup against chat clips
    const { audioClips, chatClips: _ } = dedupClips(audioCandidates, chatClips, audioCandidates);

    if (!audioClips.length) {
      $('#audio-clips-intro').textContent = 'No distinct audio peaks found above baseline (all overlapped with chat clips or energy was flat).';
      return;
    }

    // Add metadata for render (audio clips have no chat sample)
    audioClips.forEach(c => {
      c.sample = [];
      c.laughs = 0; c.hype = 0; c.hypeEmotes = 0; c.unique = 0; c.msgCount = 0;
      c.z = 0; c.audioBoost = c.score;
      c.audioMoments = [];
      c.isAudioClip = true;
    });

    // Render
    const currentVodId = vodId;
    const firstChatState = window.__clipState && [...window.__clipState.values()][0];
    const ch = firstChatState ? firstChatState.channelName : '';
    renderStudioClips(audioClips, 'audio-clips-list', 'audio', currentVodId, ch, duration);
    // Show audio tab button
    const audioTabBtn = $('#studio-tab-audio-btn');
    if (audioTabBtn) audioTabBtn.style.display = '';
    $('#audio-clips-intro').innerHTML =
      `<strong>${audioClips.length}</strong> moments with high audio energy — loud reactions, music drops, sudden silence breaks. ` +
      `Deduplicated against chat clips (${audioCandidates.length - audioClips.length} removed as overlapping).`;
    log(`Dense audio scan complete: ${audioClips.length} audio clips found.`, 'ok');

    // Rebuild high score tab now that audio clips are available
    const chatClipsForHS = window.__studioClips && window.__studioClips['chat'] ? window.__studioClips['chat'] : chatClips;
    buildAndRenderHighScoreClips(chatClipsForHS, audioClips, currentVodId, ch, duration);
  } catch (e) {
    $('#audio-clips-intro').innerHTML = `<span style="color:var(--danger)">Audio scan failed: ${escapeHTML(e.message)}</span>`;
    log('Dense audio scan error: ' + e.message, 'err');
  }
}

// ===============================================
// Studio inner tab switching
// ===============================================
// Tracks which studio tab is currently shown — used to guard renders that
// fire asynchronously (e.g. buildAndRenderHighScoreClips after dense scan).
window.__activeStudioTab = null;
// Per-tab loader: set by renderStudioClips so switchStudioTab can trigger it.
window.__studioTabLoader = {};

function switchStudioTab(name) {
  // Stop playback and clear highlights on ALL tabs unconditionally — the
  // previous approach of only clearing the visible panel missed cases where
  // async re-renders (dense scan, high score rebuild) ran while a different
  // tab was showing, leaving stale .active state on the hidden tab's tiles.
  ['highscore', 'chat', 'audio'].forEach(k => {
    const tabSuffix = k === 'highscore' ? 'hs' : k;
    const iframe = document.getElementById('studio-' + tabSuffix + '-iframe');
    if (iframe) iframe.src = '';
    const panel = document.getElementById('studio-panel-' + k);
    if (panel) panel.querySelectorAll('.studio-tile').forEach(t => t.classList.remove('active'));
  });

  window.__activeStudioTab = name;

  document.querySelectorAll('.studio-tab-btn').forEach(b => {
    const active = b.dataset.studio === name;
    b.style.color = active ? 'var(--ink)' : 'var(--ink-dim)';
    b.style.fontWeight = active ? '600' : '500';
    b.style.borderBottomColor = active ? 'var(--ink)' : 'transparent';
  });
  ['highscore', 'chat', 'audio'].forEach(panel => {
    const el = document.getElementById('studio-panel-' + panel);
    if (el) el.style.display = panel === name ? '' : 'none';
  });

  // Trigger the first-clip loader for the incoming tab (autoplay=true).
  // This is set by renderStudioClips when the tab's clips are rendered.
  const loader = window.__studioTabLoader[name];
  if (loader) loader(true);
}
window.switchStudioTab = switchStudioTab;

// Wire studio tab buttons
document.addEventListener('click', e => {
  const btn = e.target.closest('.studio-tab-btn');
  if (btn && btn.dataset.studio) switchStudioTab(btn.dataset.studio);
});

// ===============================================
// ===============================================
// Audio energy sparkline for audio-peak clip detail
// ===============================================
// Draws an inline SVG line graph of the energyCurve centred on the clip window.
// Shows ±90s of context around the clip, with a shaded band marking the clip itself.
function drawAudioSparkline(clip, energyCurve) {
  if (!energyCurve || energyCurve.length < 3) return '';

  const PAD_SEC = 90; // context either side of the clip
  const viewStart = Math.max(0, clip.start - PAD_SEC);
  const viewEnd   = clip.end + PAD_SEC;

  // Points within the view window
  const pts = energyCurve.filter(p => p.t >= viewStart && p.t <= viewEnd);
  if (pts.length < 2) return '';

  // Normalise RMS to [0,1] within this window so quiet streams still show shape
  const maxRms = Math.max(...pts.map(p => p.rms), 1e-9);
  const norm = pts.map(p => ({ t: p.t, v: p.rms / maxRms }));

  const W = 500, H = 72, padX = 4, padY = 6;
  const tRange = viewEnd - viewStart || 1;

  function tx(t) { return padX + ((t - viewStart) / tRange) * (W - padX * 2); }
  function ty(v) { return padY + (1 - v) * (H - padY * 2); }

  // Polyline points
  const polyline = norm.map(p => `${tx(p.t).toFixed(1)},${ty(p.v).toFixed(1)}`).join(' ');

  // Shaded region for the clip window
  const clipX1 = tx(clip.start).toFixed(1);
  const clipX2 = tx(clip.end).toFixed(1);
  const clipW  = (tx(clip.end) - tx(clip.start)).toFixed(1);

  // Time labels
  function fmtT(sec) {
    const h = Math.floor(sec/3600), m = Math.floor(sec%3600/60), s = Math.floor(sec%60);
    return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${m}:${String(s).padStart(2,'0')}`;
  }

  return `
    <div style="margin: 10px 0 4px;">
      <div style="font-size:11px;font-weight:600;color:var(--ink-faint);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">Audio energy</div>
      <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"
           style="width:100%;height:auto;display:block;background:var(--surface-2);border-radius:var(--r-sm);border:1px solid var(--border);">
        <!-- Clip window highlight -->
        <rect x="${clipX1}" y="${padY}" width="${clipW}" height="${H - padY * 2}"
              fill="var(--warning)" opacity="0.18" rx="2"/>
        <!-- Baseline -->
        <line x1="${padX}" y1="${H - padY}" x2="${W - padX}" y2="${H - padY}"
              stroke="var(--border-strong)" stroke-width="1"/>
        <!-- Energy line -->
        <polyline points="${polyline}"
                  fill="none" stroke="var(--warning)" stroke-width="2"
                  stroke-linejoin="round" stroke-linecap="round"/>
        <!-- Clip start/end tick marks -->
        <line x1="${clipX1}" y1="${padY}" x2="${clipX1}" y2="${H - padY}"
              stroke="var(--warning)" stroke-width="1.5" stroke-dasharray="3,2" opacity="0.7"/>
        <line x1="${clipX2}" y1="${padY}" x2="${clipX2}" y2="${H - padY}"
              stroke="var(--warning)" stroke-width="1.5" stroke-dasharray="3,2" opacity="0.7"/>
        <!-- Time labels -->
        <text x="${padX + 2}" y="${H - 1}" font-size="9" fill="var(--ink-faint)" font-family="monospace">${fmtT(viewStart)}</text>
        <text x="${(W / 2).toFixed(0)}" y="${H - 1}" font-size="9" fill="var(--warning)" font-family="monospace"
              text-anchor="middle">${fmtT(clip.start)}–${fmtT(clip.end)}</text>
        <text x="${W - padX - 2}" y="${H - 1}" font-size="9" fill="var(--ink-faint)" font-family="monospace"
              text-anchor="end">${fmtT(viewEnd)}</text>
      </svg>
    </div>
  `;
}

// Studio tile renderer (replaces renderClips in Studio context)
// ===============================================
// Renders compact tile grid + shared per-tab player above it.
// tabKey: 'highscore' | 'chat' | 'audio'
function renderStudioClips(clips, gridId, tabKey, vodId, channelName, vodDuration) {
  if (!window.__studioClips) window.__studioClips = {};
  // Stash vodId on each clip so switchStudioTab can build the iframe src without
  // needing closure access to vodId.
  clips.forEach(c => { c.__vodId = vodId; });
  window.__studioClips[tabKey] = clips;

  const gridEl = document.getElementById(gridId);
  if (!gridEl) return;

  if (!clips.length) {
    gridEl.innerHTML = '<div style="padding:20px 0; color:var(--ink-faint); font-size:14px; grid-column: 1/-1;">No moments found for this section.</div>';
    return;
  }

  const tabSuffix = tabKey === 'highscore' ? 'hs' : tabKey;
  const playerEl = document.getElementById('studio-' + tabSuffix + '-player');
  const iframeEl = document.getElementById('studio-' + tabSuffix + '-iframe');
  const detailEl = document.getElementById('studio-' + tabSuffix + '-detail');

  // For highscore clips, normScore is the absolute 0–10 value used for filtering.
  // For chat/audio tabs, fall back to relative normalisation within the set.
  const hasAbsoluteScore = clips.every(c => c.normScore != null);
  const maxScore = hasAbsoluteScore ? 10 : Math.max(...clips.map(c => c.score), 1);

  gridEl.innerHTML = clips.map((c, i) => {
    const displayScore = hasAbsoluteScore ? c.normScore : (c.score / maxScore) * 10;
    const scorePct = Math.min(100, (displayScore / 10) * 100);
    const scoreDisplay = displayScore.toFixed(1) + '/10';
    const hasChatBadge = c.z > 1.5 || (!c.isAudioClip && c.score > 0);
    const hasAudioBadge = c.audioBoost > 0.5 || c.isAudioClip;
    return `
      <button class="studio-tile" data-tile-idx="${i}" data-tab-key="${tabKey}">
        <div class="studio-tile-rank">№ ${String(i+1).padStart(2,'0')}</div>
        <div class="studio-tile-ts">${fmtDur(c.start)}</div>
        <div class="studio-tile-score-bar"><div class="studio-tile-score-fill" style="width:${scorePct.toFixed(1)}%"></div></div>
        <div class="studio-tile-score-label">${scoreDisplay}</div>
        <div class="studio-tile-sources">
          ${hasChatBadge ? '<span class="clip-source-tag chat">💬 chat</span>' : ''}
          ${hasAudioBadge ? '<span class="clip-source-tag audio">🔊 audio</span>' : ''}
        </div>
      </button>
    `;
  }).join('');

  function loadTilePlayer(clip, idx, autoplay) {
    if (!playerEl || !iframeEl) return;
    playerEl.style.display = '';
    const parentDomain = window.location.hostname || 'localhost';
    const t = Math.floor(clip.start);
    const hrs = Math.floor(t/3600);
    const mins = Math.floor(t%3600/60);
    const secs = t%60;
    const src = `https://player.twitch.tv/?video=v${vodId}&parent=${parentDomain}&time=${hrs}h${mins}m${secs}s&autoplay=${autoplay ? 'true' : 'false'}`;
    iframeEl.src = src;
    // Detail panel
    if (detailEl) {
      const sampleHTML = (clip.sample || []).slice(0,5).map(m =>
        `<span class="user">${escapeHTML(m.user)}:</span> ${escapeHTML((m.msg||'').slice(0,80))}`
      ).join('<br>');
      // Audio tab: show energy sparkline instead of chat sample
      const contentHTML = tabKey === 'audio'
        ? drawAudioSparkline(clip, window.__energyCurve || [])
        : (sampleHTML ? `<div class="clip-chat-sample" style="margin:0;">${sampleHTML}</div>` : '');
      detailEl.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap;">
          <span style="font-family:var(--mono);font-size:15px;font-weight:700;">${fmtDur(clip.start)}</span>
          <span style="font-size:13px;color:var(--ink-dim);">${Math.round(clip.end - clip.start)}s window</span>
          ${clip.audioBoost > 0.5 || clip.isAudioClip ? '<span class="clip-source-tag audio">🔊 audio peak</span>' : ''}
          ${clip.z > 1.5 ? '<span class="clip-source-tag chat">💬 chat spike</span>' : ''}
          <a href="https://www.twitch.tv/videos/${vodId}?t=${Math.floor(clip.start/3600)}h${Math.floor(clip.start%3600/60)}m${Math.floor(clip.start%60)}s" target="_blank" style="margin-left:auto;text-decoration:none;"><button class="ghost small">▶ Open on Twitch</button></a>
        </div>
        <div style="font-size:13px;color:var(--ink-2);margin-bottom:6px;">${clipReason(clip)}</div>
        ${contentHTML}
      `;
    }
    // Highlight active tile — scoped strictly to this grid
    gridEl.querySelectorAll('.studio-tile').forEach((t, ti) => t.classList.toggle('active', ti === idx));
  }

  // Register a loader for this tab so switchStudioTab can trigger it on entry.
  // The loader loads clip[0] (or re-uses existing idx) into the player.
  window.__studioTabLoader[tabKey] = function(autoplay) {
    loadTilePlayer(clips[0], 0, autoplay);
  };

  // If this tab is currently active, load the first clip now (autoplay).
  // If it's a background render (e.g. high score rebuilding while user is on
  // chat tab), do NOT touch player or highlights — switchStudioTab will trigger
  // the loader when the user navigates here.
  if (window.__activeStudioTab === tabKey) {
    loadTilePlayer(clips[0], 0, true);
  }

  gridEl.querySelectorAll('.studio-tile').forEach((tile, idx) => {
    tile.addEventListener('click', () => {
      if (window.__activeStudioTab !== tabKey) return;
      loadTilePlayer(clips[idx], idx, true);
    });
  });
}

// ===============================================
// Build and render High Score Clips tab
// ===============================================
// Merges chat clips (score >= 4 raw or normalised >= 4/10) with audio clips
// (score >= 4 z or normalised), deduplicates within 20s, stores result.
function buildAndRenderHighScoreClips(chatClips, audioClips, vodId, channelName, vodDuration) {
  if (!window.__studioClips) window.__studioClips = {};

  const chatMax = Math.max(...(chatClips || []).map(c => c.score), 1);
  const audioMax = Math.max(...(audioClips || []).map(c => c.score), 1);

  // Normalise to 0-10
  const chatNorm = (chatClips || []).map(c => ({ ...c, normScore: (c.score / chatMax) * 10, _src: 'chat' }));
  const audioNorm = (audioClips || []).map(c => ({ ...c, normScore: (c.score / audioMax) * 10, _src: 'audio' }));

  // Filter >= 4.0 normalised
  const candidates = [...chatNorm.filter(c => c.normScore >= 4.0), ...audioNorm.filter(c => c.normScore >= 4.0)];

  // Sort by normalised score desc
  candidates.sort((a, b) => b.normScore - a.normScore);

  // Deduplicate within 20s
  const merged = [];
  for (const c of candidates) {
    if (merged.some(m => Math.abs(m.start - c.start) < 20)) continue;
    merged.push(c);
    if (merged.length >= 15) break;
  }

  // Store — already descending by normScore (dedup preserves sort order)
  merged.sort((a, b) => b.normScore - a.normScore);
  window.__studioClips['highscore'] = merged;

  const intro = $('#highscore-clips-intro');
  if (intro) {
    if (merged.length) {
      const chatCount = merged.filter(c => c._src === 'chat').length;
      const audioCount = merged.filter(c => c._src === 'audio').length;
      intro.innerHTML = `<strong>${merged.length}</strong> moments scoring ≥ 4/10 — ${chatCount} from chat${audioCount ? `, ${audioCount} from audio` : ''}. Best clips for social media.`;
    } else {
      intro.innerHTML = 'No moments scored ≥ 4/10 yet. Try enabling the audio proxy for more candidates.';
    }
  }

  if (merged.length > 0) {
    renderStudioClips(merged, 'highscore-clips-grid', 'highscore', vodId, channelName, vodDuration);
  } else {
    const g = $('#highscore-clips-grid');
    if (g) g.innerHTML = '<div style="padding:20px 0;color:var(--ink-faint);font-size:14px;grid-column:1/-1;">No clips met the ≥ 4/10 threshold yet.</div>';
  }
}

// ===============================================
// Exports — attach to window so index.html can call these
// ===============================================
window.scoreClips = scoreClips;
window.scoreAudioClips = scoreAudioClips;
window.dedupClips = dedupClips;
window.renderStudioClips = renderStudioClips;
window.buildAndRenderHighScoreClips = buildAndRenderHighScoreClips;
window.switchStudioTab = switchStudioTab;
window.runDenseAudioScan = runDenseAudioScan;
