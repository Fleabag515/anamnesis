/**
 * lib/proxy-helpers.js — pure helpers extracted from proxy.js so they are
 * testable without booting the HTTP server or touching the DB.
 *
 * Nothing here imports config or any stateful module; everything takes its
 * dependencies as arguments.
 */

const crypto = require('crypto');
const os = require('os');

/**
 * Safely flatten OpenAI-style chat-completion `content` into a plain string.
 *
 * OpenAI-compatible clients (including OpenClaw) may send a message's
 * `content` as either a string OR an array of content parts:
 *   [{ type: 'text', text: '...' }, { type: 'tool_result', ... }, ...]
 *
 * SQLite (via better-sqlite3) only binds strings/buffers/numbers/null, so
 * we used to crash with a TypeError on every multipart request. Falls back
 * to JSON.stringify() for non-text parts so nothing is silently dropped.
 *
 * Imported in the proxy (for storing the user turn) and the selector (so
 * the query embedding sees the same text the user actually wrote).
 */
function extractContentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = content
      .filter((p) => p?.type === 'text' || p?.text)
      .map((p) => p?.text ?? p?.content ?? '')
      .join('\n')
      .trim();
    return text || JSON.stringify(content);
  }
  if (content && typeof content === 'object') return JSON.stringify(content);
  return String(content ?? '');
}

/**
 * Recursively expand `~`, `${HOME}` and `$HOME` in string values inside a
 * (possibly nested) config object. Lets config.json ship a portable default
 * like `~/.anamnesis/history.db` instead of a machine-specific absolute path.
 */
function expandHome(obj, home = os.homedir()) {
  if (obj == null) return obj;
  if (typeof obj === 'string') {
    return obj
      .replace(/^~(?=\/|$)/, home)
      .replace(/\$\{HOME\}/g, home)
      .replace(/\$HOME(?=\/|$)/g, home);
  }
  if (Array.isArray(obj)) return obj.map((v) => expandHome(v, home));
  if (typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = expandHome(v, home);
    return out;
  }
  return obj;
}

/**
 * Derive a stable session key from request headers.
 *
 * Order of precedence:
 *   1. X-OpenClaw-Session / X-Session-Id explicit headers
 *   2. SHA-256 prefix of the bearer token (avoids leaking credential bytes)
 *   3. "default" for unauthenticated local clients
 */
function getSessionKey(headers, upstreamApiKey = '') {
  const explicit = headers['x-openclaw-session'] ?? headers['x-session-id'];
  if (explicit) return `oc:${explicit}`;

  const auth = headers['authorization'] ?? '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (token && token !== upstreamApiKey) {
    const hash = crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
    return `auth:${hash}`;
  }
  return 'default';
}

/**
 * Build outgoing headers for an upstream HTTP request.
 *
 *   - inject our configured upstream API key when set
 *   - otherwise pass the client's Authorization through untouched
 *   - strip hop-by-hop and proxy-internal headers
 *   - drop Content-Length so the caller can recompute against the (possibly
 *     rewritten) body
 */
function buildUpstreamHeaders(incomingHeaders, { upstreamApiKey } = {}) {
  const headers = { ...incomingHeaders };
  delete headers['x-openclaw-session'];
  delete headers['x-session-id'];
  delete headers['host'];
  for (const k of Object.keys(headers)) {
    const lk = k.toLowerCase();
    if (lk === 'content-length' || lk === 'connection' || lk === 'transfer-encoding') {
      delete headers[k];
    }
  }
  if (upstreamApiKey) {
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === 'authorization') delete headers[k];
    }
    headers['Authorization'] = `Bearer ${upstreamApiKey}`;
  }
  return headers;
}

/**
 * Stateful accumulator for OpenAI-style SSE chat-completion streams.
 * Pass each chunk through `.feed(chunk)`; read the reconstructed assistant
 * content from `.content` after the stream ends.
 *
 * Handles:
 *   - frames split across chunk boundaries (buffered until next newline pair)
 *   - keepalive lines that aren't valid JSON
 *   - both delta.content (streaming) and message.content (final) shapes
 *   - `[DONE]` sentinel
 */
function makeSseAccumulator() {
  let buf = '';
  let content = '';
  return {
    feed(chunk) {
      buf += chunk.toString('utf8');
      const parts = buf.split(/\n\n/);
      buf = parts.pop(); // possibly incomplete tail
      for (const frame of parts) {
        for (const line of frame.split(/\n/)) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const j = JSON.parse(payload);
            const delta =
              j?.choices?.[0]?.delta?.content ?? j?.choices?.[0]?.message?.content ?? '';
            if (delta) content += delta;
          } catch {
            /* ignore keepalives / partials */
          }
        }
      }
    },
    get content() {
      return content;
    },
  };
}

module.exports = {
  expandHome,
  extractContentText,
  getSessionKey,
  buildUpstreamHeaders,
  makeSseAccumulator,
};
