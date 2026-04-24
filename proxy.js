/**
 * VOD Desk — Express Server (Railway Edition)
 * ============================================
 *
 * Serves the static frontend AND acts as the audio proxy.
 *
 *   GET  /              → serves public/index.html
 *   GET  /lib/*         → serves public/lib/*
 *   GET  /health        → JSON health check
 *   GET  /proxy?url=    → raw byte passthrough (playlists, GQL, etc.)
 *   GET  /proxy-audio?url=  → MPEG-TS → ADTS/AAC demux
 *   POST /api/claude    → server-side Claude relay (reads ANTHROPIC_API_KEY from env)
 *
 * HOW TO RUN LOCALLY:
 *   npm install
 *   ANTHROPIC_API_KEY=sk-ant-... node proxy.js
 *
 * ON RAILWAY:
 *   Set ANTHROPIC_API_KEY as an environment variable in the Railway dashboard.
 *   Railway will run:  node proxy.js
 */

const express = require('express');
const path = require('path');

const PORT = process.env.PORT || 7777;
const HOST = process.env.HOST || '0.0.0.0'; // Railway needs 0.0.0.0

// Only allow proxying to these Twitch-owned domains.
const ALLOWED_DOMAINS = [
  'usher.ttvnw.net',
  'gql.twitch.tv',
  '.ttvnw.net',
  '.cloudfront.net',
  '.hls.ttvnw.net',
];

function isAllowed(url) {
  try {
    const u = new URL(url);
    return ALLOWED_DOMAINS.some(d => d.startsWith('.')
      ? u.hostname.endsWith(d)
      : u.hostname === d);
  } catch {
    return false;
  }
}

function setCORSHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Client-Id, Authorization');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Type, X-Demuxed, X-Demux-Error');
}

// ============================================================================
// MPEG-TS → ADTS/AAC demuxer (unchanged from v2)
// ============================================================================

function demuxTStoADTS(tsBytes) {
  const PACKET_SIZE = 188;
  if (tsBytes.length < PACKET_SIZE || tsBytes[0] !== 0x47) {
    throw new Error('Not a valid MPEG-TS stream (missing sync byte)');
  }

  let audioPID = -1;
  let pmtPID = -1;

  for (let offset = 0; offset + PACKET_SIZE <= tsBytes.length; offset += PACKET_SIZE) {
    if (tsBytes[offset] !== 0x47) continue;
    const pid = ((tsBytes[offset + 1] & 0x1F) << 8) | tsBytes[offset + 2];
    const payloadStart = (tsBytes[offset + 1] & 0x40) !== 0;
    const adaptationField = (tsBytes[offset + 3] & 0x30) >> 4;
    let payloadOffset = offset + 4;
    if (adaptationField === 2 || adaptationField === 3) {
      const afLen = tsBytes[offset + 4];
      payloadOffset = offset + 5 + afLen;
    }

    if (pid === 0 && payloadStart) {
      const pointer = tsBytes[payloadOffset];
      const patStart = payloadOffset + 1 + pointer;
      const sectionLen = ((tsBytes[patStart + 1] & 0x0F) << 8) | tsBytes[patStart + 2];
      const programsStart = patStart + 8;
      const programsEnd = patStart + 3 + sectionLen - 4;
      for (let p = programsStart; p + 4 <= programsEnd; p += 4) {
        const prog = (tsBytes[p] << 8) | tsBytes[p + 1];
        const pmt = ((tsBytes[p + 2] & 0x1F) << 8) | tsBytes[p + 3];
        if (prog !== 0) { pmtPID = pmt; break; }
      }
    } else if (pid === pmtPID && payloadStart && pmtPID >= 0) {
      const pointer = tsBytes[payloadOffset];
      const pmtStart = payloadOffset + 1 + pointer;
      const sectionLen = ((tsBytes[pmtStart + 1] & 0x0F) << 8) | tsBytes[pmtStart + 2];
      const programInfoLen = ((tsBytes[pmtStart + 10] & 0x0F) << 8) | tsBytes[pmtStart + 11];
      let esStart = pmtStart + 12 + programInfoLen;
      const esEnd = pmtStart + 3 + sectionLen - 4;
      while (esStart + 5 <= esEnd) {
        const streamType = tsBytes[esStart];
        const esPid = ((tsBytes[esStart + 1] & 0x1F) << 8) | tsBytes[esStart + 2];
        const esInfoLen = ((tsBytes[esStart + 3] & 0x0F) << 8) | tsBytes[esStart + 4];
        if (streamType === 0x0F || streamType === 0x11) {
          audioPID = esPid;
          break;
        }
        esStart += 5 + esInfoLen;
      }
      if (audioPID >= 0) break;
    }
  }

  if (audioPID < 0) audioPID = 0x101;

  const pesChunks = [];
  let currentPES = null;

  for (let offset = 0; offset + PACKET_SIZE <= tsBytes.length; offset += PACKET_SIZE) {
    if (tsBytes[offset] !== 0x47) continue;
    const pid = ((tsBytes[offset + 1] & 0x1F) << 8) | tsBytes[offset + 2];
    if (pid !== audioPID) continue;

    const payloadStart = (tsBytes[offset + 1] & 0x40) !== 0;
    const adaptationField = (tsBytes[offset + 3] & 0x30) >> 4;
    let payloadOffset = offset + 4;
    if (adaptationField === 2 || adaptationField === 3) {
      const afLen = tsBytes[offset + 4];
      payloadOffset = offset + 5 + afLen;
    }
    if (payloadOffset >= offset + PACKET_SIZE) continue;
    const payloadEnd = offset + PACKET_SIZE;

    if (payloadStart) {
      if (currentPES) pesChunks.push(currentPES);
      currentPES = Buffer.from(tsBytes.slice(payloadOffset, payloadEnd));
    } else if (currentPES) {
      currentPES = Buffer.concat([currentPES, Buffer.from(tsBytes.slice(payloadOffset, payloadEnd))]);
    }
  }
  if (currentPES) pesChunks.push(currentPES);

  const adtsFrames = [];
  for (const pes of pesChunks) {
    if (pes.length < 9 || pes[0] !== 0x00 || pes[1] !== 0x00 || pes[2] !== 0x01) continue;
    if (pes[3] < 0xC0 || pes[3] > 0xDF) continue;
    const pesHeaderDataLen = pes[8];
    const aacStart = 9 + pesHeaderDataLen;
    if (aacStart >= pes.length) continue;
    adtsFrames.push(pes.slice(aacStart));
  }

  if (!adtsFrames.length) {
    throw new Error(`No AAC frames extracted (audioPID=${audioPID}, pesCount=${pesChunks.length})`);
  }
  return Buffer.concat(adtsFrames);
}

// ============================================================================
// Rate limiter — in-memory, IP-based (R2)
// 10 Claude API calls per IP per 60 minutes.
// ============================================================================

const rateLimitMap = new Map(); // ip → { count, resetAt }
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 60 minutes

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count++;
  return true;
}

// Clean up expired entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(ip);
  }
}, 10 * 60 * 1000);

// ============================================================================
// Fetch helper
// ============================================================================

async function fetchFromTwitch(target, reqHeaders, reqMethod, reqBody) {
  const fetchOptions = {
    method: reqMethod,
    headers: { 'User-Agent': 'VOD-Desk-Proxy/2.0' },
  };
  if (reqHeaders['client-id']) fetchOptions.headers['Client-Id'] = reqHeaders['client-id'];
  if (reqHeaders['authorization']) fetchOptions.headers['Authorization'] = reqHeaders['authorization'];
  if (reqHeaders['content-type']) fetchOptions.headers['Content-Type'] = reqHeaders['content-type'];
  if (reqMethod === 'POST' && reqBody) fetchOptions.body = reqBody;
  return fetch(target, fetchOptions);
}

// ============================================================================
// Express app
// ============================================================================

const app = express();

// Parse raw bodies for proxy routes (before express.json)
app.use('/proxy', express.raw({ type: '*/*', limit: '10mb' }));
app.use('/proxy-audio', express.raw({ type: '*/*', limit: '10mb' }));

// Parse JSON for /api/claude
app.use('/api', express.json());

// Serve static files from public/
app.use(express.static(path.join(__dirname, 'public')));

// CORS on all responses
app.use((req, res, next) => {
  setCORSHeaders(res);
  next();
});

// OPTIONS preflight
app.options('*', (req, res) => res.sendStatus(204));

// ── Health ──
app.get('/health', (req, res) => {
  res.json({ ok: true, name: 'vod-desk-proxy', version: 2, features: ['ts-demux', 'claude-relay'] });
});

// ── Claude relay (R2) ──
app.post('/api/claude', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured on server' });
  }

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }

  const { system, user, maxTokens } = req.body || {};
  if (!user) return res.status(400).json({ error: 'Missing user message' });

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: maxTokens || 1000,
        system: system || '',
        messages: [{ role: 'user', content: user }],
      }),
    });
    const data = await upstream.json();
    if (!upstream.ok) return res.status(upstream.status).json(data);
    res.json(data);
  } catch (err) {
    console.error('[/api/claude]', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ── Proxy routes ──
async function handleProxy(req, res, isAudioMode) {
  const target = req.query.url;
  if (!target) { res.status(400).send('Missing ?url='); return; }
  if (!isAllowed(target)) {
    console.log(`[BLOCKED] ${target}`);
    res.status(403).send('URL not allowed');
    return;
  }

  try {
    const mode = isAudioMode ? 'AUDIO' : 'PLAIN';
    console.log(`[${mode}] ${target.slice(0, 110)}${target.length > 110 ? '...' : ''}`);

    const reqBody = (req.method === 'POST' && req.body && req.body.length) ? req.body : null;
    const upstream = await fetchFromTwitch(target, req.headers, req.method, reqBody);

    if (!upstream.ok) {
      res.status(upstream.status).type('text').send(`Upstream returned ${upstream.status}`);
      console.log(`[FAIL] ${upstream.status} ${target.slice(0, 80)}`);
      return;
    }

    if (isAudioMode) {
      const bytes = Buffer.from(await upstream.arrayBuffer());
      try {
        const adts = demuxTStoADTS(bytes);
        res.set({ 'Content-Type': 'audio/aac', 'X-Demuxed': '1' });
        res.send(adts);
        console.log(`[OK]    demuxed ${bytes.length} → ${adts.length} bytes`);
      } catch (e) {
        console.log(`[WARN]  demux failed (${e.message}), passing through raw`);
        res.set({
          'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
          'X-Demuxed': '0',
          'X-Demux-Error': e.message,
        });
        res.send(bytes);
      }
    } else {
      res.status(upstream.status);
      res.set('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
      if (upstream.body) {
        const reader = upstream.body.getReader();
        const writeChunk = async () => {
          const { done, value } = await reader.read();
          if (done) { res.end(); return; }
          res.write(value);
          await writeChunk();
        };
        await writeChunk();
      } else {
        res.end();
      }
      console.log(`[OK]    ${upstream.status} (passthrough)`);
    }
  } catch (err) {
    console.log(`[ERROR] ${err.message}`);
    res.status(502).type('text').send(`Proxy error: ${err.message}`);
  }
}

app.all('/proxy', (req, res) => handleProxy(req, res, false));
app.all('/proxy-audio', (req, res) => handleProxy(req, res, true));

// ── Start ──
app.listen(PORT, HOST, () => {
  console.log('================================================');
  console.log('  VOD Desk — Express Server  v2  (Railway)');
  console.log('================================================');
  console.log(`  Running at:  http://${HOST}:${PORT}`);
  console.log(`  Health URL:  http://${HOST}:${PORT}/health`);
  console.log('');
  console.log('  Static:  ./public/');
  console.log('  Claude relay:  POST /api/claude');
  console.log('  Proxy:  /proxy  /proxy-audio');
  console.log('');
  console.log('  Keep this window open. Ctrl+C to stop.');
  console.log('================================================');
}).on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use.\n`);
  } else {
    console.error('Server error:', err);
  }
  process.exit(1);
});
