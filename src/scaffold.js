/**
 * scaffold.js — Reasoning Scaffold (tier classification + plan injection
 * + tool-result reflection). Spec §7A.
 *
 * Three exports:
 *   - isTrivial(messages, cfg)        — Phase α
 *   - planBlock(intent, cfg)          — Phase α
 *   - toolReflectionBlock(messages, cfg) — Phase α
 *
 * All pure functions; no side effects, no DB, no HTTP.
 */

const { extractContentText } = require('./lib/proxy-helpers.js');

const DEFAULT_TRIVIAL_MARKERS = [
  'ok',
  'okay',
  'k',
  'thanks',
  'thank you',
  'cool',
  'nice',
  'lol',
  'haha',
  'yes',
  'no',
  'sure',
  'got it',
];

/**
 * Decide whether the last user message is "trivial" — i.e. the request
 * should bypass the selector, the scaffold, and all memory injection.
 *
 * Conservative: returns true only for short, non-question messages that
 * either match an explicit marker list or are ≤20 chars total.
 *
 * @param {Array} messages — OpenAI-style messages array
 * @param {Object} cfg — scaffold config block (§9). Reads
 *   trivialEnabled, trivialMaxChars, trivialMarkers.
 * @returns {boolean}
 */
function isTrivial(messages, cfg = {}) {
  if (cfg.trivialEnabled === false) return false;
  if (!Array.isArray(messages) || messages.length === 0) return false;

  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user') return false;

  const text = extractContentText(last.content).trim().toLowerCase();
  if (!text) return false;

  const maxChars = cfg.trivialMaxChars ?? 80;
  if (text.length > maxChars) return false;

  if (text.includes('?')) return false;

  const markers = cfg.trivialMarkers ?? DEFAULT_TRIVIAL_MARKERS;
  // Match either: starts with a marker followed by a word boundary,
  //               OR overall length ≤ 20 chars (covers "👍", "yeah", "ty").
  // The length-only fall-through is a safety net for the DEFAULT marker
  // list (which already covers casuals like "thanks"); if a caller
  // supplies an explicit custom marker list they get the marker rule only.
  const escaped = markers.map((m) => m.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const markerRe = new RegExp(`^(${escaped.join('|')})\\b`, 'i');
  if (markerRe.test(text)) return true;

  // The length-only fall-through applies when the supplied marker list
  // is the default set (or equivalent). Callers who pass a custom list
  // are declaring exactly what counts as trivial — no implicit safety net.
  const usingDefaults =
    !cfg.trivialMarkers ||
    cfg.trivialMarkers === DEFAULT_TRIVIAL_MARKERS ||
    (Array.isArray(cfg.trivialMarkers) &&
      cfg.trivialMarkers.length === DEFAULT_TRIVIAL_MARKERS.length &&
      cfg.trivialMarkers.every((m, i) => m === DEFAULT_TRIVIAL_MARKERS[i]));
  if (usingDefaults && text.length <= 20) return true;
  return false;
}

module.exports = { isTrivial, DEFAULT_TRIVIAL_MARKERS };
