/**
 * lib/ollama.js — shared HTTP client for Ollama (and any plain HTTP host).
 *
 * Both extractor.js, foresight.js, embedder.js, and consolidator.js used to
 * carry their own copies of this. One implementation, one place to fix bugs.
 *
 * Exports:
 *   post(url, path, body, { timeoutMs }) — Promise<string> of raw response body
 *   chat(url, { model, messages, options, timeoutMs }) — Promise<string> of
 *       the assistant message content extracted from /api/chat
 *   generate(url, { model, prompt, options, timeoutMs }) — same but /api/generate
 */

const http = require('http');
const https = require('https');

function post(baseUrl, path, body, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl);
    const lib = u.protocol === 'https:' ? https : http;
    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = lib.request(opts, (res) => {
      let buf = '';
      res.on('data', (d) => (buf += d));
      res.on('end', () => resolve(buf));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`request to ${path} timed out after ${timeoutMs}ms`));
    });
    req.write(body);
    req.end();
  });
}

async function chat(baseUrl, { model, messages, options = {}, timeoutMs = 45000, think = false }) {
  const body = JSON.stringify({ model, messages, stream: false, think, options });
  const raw = await post(baseUrl, '/api/chat', body, { timeoutMs });
  const parsed = JSON.parse(raw);
  return (parsed?.message?.content ?? '').trim();
}

async function generate(baseUrl, { model, prompt, options = {}, timeoutMs = 90000 }) {
  const body = JSON.stringify({ model, prompt, stream: false, options });
  const raw = await post(baseUrl, '/api/generate', body, { timeoutMs });
  const parsed = JSON.parse(raw);
  return (parsed?.response ?? '').trim();
}

/**
 * Try to extract a JSON array from arbitrary LLM output (handles markdown
 * fences, leading prose, etc.). Returns null on failure.
 */
function tryParseJsonArray(text) {
  if (!text) return null;
  // Grab the first top-level `[...]` block — non-greedy so we don't accidentally
  // capture trailing junk if there's a second array later.
  const match = text.match(/\[[\s\S]*?\]/);
  if (!match) return null;
  try {
    const arr = JSON.parse(match[0]);
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}

/**
 * Try to extract a JSON object `{...}` from arbitrary LLM output.
 */
function tryParseJsonObject(text) {
  if (!text) return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]);
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

module.exports = { post, chat, generate, tryParseJsonArray, tryParseJsonObject };
