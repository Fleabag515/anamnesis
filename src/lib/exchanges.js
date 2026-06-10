/**
 * lib/exchanges.js — pure helpers for structure-aware context eviction.
 *
 * An agentic conversation is not a flat list of messages: an assistant
 * message carrying `tool_calls` and the `role:"tool"` results that answer it
 * form one atomic *exchange*. Evicting half of such a unit produces orphaned
 * tool messages (strict backends 400 on them; lenient ones silently confuse
 * the model). Everything here groups messages into units, costs them, and
 * decides what to keep — without touching the DB or the network, so it is
 * unit-testable in isolation (same philosophy as proxy-helpers.js).
 */

'use strict';

/**
 * Group a conversation (non-system messages) into atomic units.
 *
 * Unit kinds:
 *   'exchange' — assistant message with tool_calls + its tool result messages
 *   'plain'    — any other single message (user, plain assistant, orphan tool)
 *
 * Orphan tool messages (no preceding assistant tool_calls in the incoming
 * array — e.g. the parent was already compacted client-side) are folded into
 * the previous exchange when one exists, otherwise become their own 'plain'
 * unit flagged `orphan:true` so the selector can rewrite them safely.
 */
function groupUnits(messages) {
  const units = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const ids = new Set(m.tool_calls.map((c) => c?.id).filter(Boolean));
      const unit = { kind: 'exchange', msgs: [m], callIds: ids };
      // absorb the tool results that answer this call (they follow it)
      while (i + 1 < messages.length && messages[i + 1].role === 'tool') {
        const t = messages[i + 1];
        // a tool msg for a *different* pending call set ends this unit
        if (t.tool_call_id && !ids.has(t.tool_call_id)) break;
        unit.msgs.push(t);
        i++;
      }
      units.push(unit);
      continue;
    }
    if (m.role === 'tool') {
      const prev = units[units.length - 1];
      if (prev && prev.kind === 'exchange') {
        prev.msgs.push(m); // late result for the previous exchange
      } else {
        units.push({ kind: 'plain', msgs: [m], orphan: true });
      }
      continue;
    }
    units.push({ kind: 'plain', msgs: [m] });
  }
  return units;
}

/**
 * Index of the unit holding the "task head" — the first user message, which
 * for agentic clients carries the actual task instruction. Returns -1 when
 * there is none (e.g. a bare tool-result replay).
 */
function taskHeadIndex(units) {
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    if (u.kind === 'plain' && u.msgs[0].role === 'user') return i;
  }
  return -1;
}

/**
 * Decide which units survive within `middleBudget` tokens.
 *
 * `costs[i]` is the token cost of unit i. Units listed in `pinned` always
 * survive (their cost is the caller's problem). The rest are kept newest-
 * first until the budget runs out; everything else is evicted oldest-first.
 *
 * Returns { keep: Set<idx>, evict: number[] (ascending = oldest first) }.
 */
function planEviction(units, costs, pinned, middleBudget) {
  const keep = new Set(pinned);
  const candidates = [];
  for (let i = 0; i < units.length; i++) if (!keep.has(i)) candidates.push(i);

  let remaining = Math.max(0, middleBudget);
  // newest-first: walk candidates from the end
  for (let j = candidates.length - 1; j >= 0; j--) {
    const idx = candidates[j];
    const cost = costs[idx] ?? 0;
    if (cost <= remaining) {
      keep.add(idx);
      remaining -= cost;
    }
  }
  const evict = candidates.filter((i) => !keep.has(i));
  return { keep, evict };
}

/** Compact, model-readable description of an evicted unit. */
function describeUnit(unit, { maxChars = 110 } = {}) {
  const first = unit.msgs[0];
  if (unit.kind === 'exchange') {
    const calls = (first.tool_calls ?? [])
      .map((c) => c?.function?.name ?? c?.name ?? 'tool')
      .join(', ');
    return `called ${calls || 'tool(s)'}`;
  }
  const text = contentToText(first.content).replace(/\s+/g, ' ').trim();
  const head = text.length > maxChars ? text.slice(0, maxChars) + '…' : text;
  return `${first.role}: ${head}`;
}

/**
 * Rewrite an evicted unit as a single, template-safe assistant line.
 * `artifactNotes` maps tool_call_id (or msg index) → handle line produced by
 * the artifact store; results that were spilled point the model at recall().
 */
function compactUnit(unit, artifactNotes = new Map()) {
  const parts = [`[compacted] ${describeUnit(unit)}`];
  for (let k = 0; k < unit.msgs.length; k++) {
    const m = unit.msgs[k];
    if (m.role !== 'tool') continue;
    const note = artifactNotes.get(m.tool_call_id ?? k);
    if (note) {
      parts.push(note);
    } else {
      const text = contentToText(m.content).replace(/\s+/g, ' ').trim();
      if (text) parts.push(`result: ${text.slice(0, 160)}${text.length > 160 ? '…' : ''}`);
    }
  }
  return { role: 'assistant', content: parts.join('\n') };
}

/** Flatten OpenAI string-or-parts content into text (loose local copy). */
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => p?.text ?? p?.content ?? '')
      .filter(Boolean)
      .join('\n');
  }
  if (content && typeof content === 'object') return JSON.stringify(content);
  return String(content ?? '');
}

/** Total text of a unit, for token costing. */
function unitText(unit) {
  return unit.msgs
    .map((m) => {
      const calls = Array.isArray(m.tool_calls) ? JSON.stringify(m.tool_calls) : '';
      return contentToText(m.content) + calls;
    })
    .join('\n');
}

module.exports = {
  groupUnits,
  taskHeadIndex,
  planEviction,
  compactUnit,
  describeUnit,
  unitText,
  contentToText,
};
