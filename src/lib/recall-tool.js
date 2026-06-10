/**
 * lib/recall-tool.js — the page-fault mechanism.
 *
 * Anamnesis injects a `recall` tool into outgoing agentic requests and
 * intercepts the model's calls to it, so the model can page evicted
 * artifacts back into context on demand. The client never sees the tool and
 * never has to implement anything: the proxy resolves recall calls itself
 * and re-queries the upstream (bounded hops).
 *
 * Injection only happens when the client itself sent a `tools` array — a
 * reliable signal of an agentic client that can cope with tool-call shaped
 * responses. Pure chat clients are left untouched.
 *
 * Pure helpers only (no IO) — the proxy owns the loop.
 */

'use strict';

const RECALL_TOOL_NAME = 'recall';

const RECALL_TOOL_DEF = {
  type: 'function',
  function: {
    name: RECALL_TOOL_NAME,
    description:
      'Reload archived context. Earlier tool results and conversation that no longer fit ' +
      'the context window are archived as artifacts like [artifact a7f3 …]. ' +
      'Call with {"id":"a7f3"} to reload one (use "offset" to page through long ones), ' +
      'or {"query":"..."} to semantically search everything archived in this session.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Artifact id from an [artifact …] marker' },
        query: { type: 'string', description: 'Semantic search over archived content' },
        offset: {
          type: 'integer',
          description: 'Character offset to continue reading a long artifact (default 0)',
        },
        max_chars: {
          type: 'integer',
          description: 'Max characters to return (default 6000)',
        },
      },
    },
  },
};

/**
 * Return a tools array including the recall tool def (idempotent).
 * Only call when the client sent a tools array — see module docs.
 */
function withRecallTool(tools) {
  const list = Array.isArray(tools) ? tools : [];
  const exists = list.some((t) => (t?.function?.name ?? t?.name) === RECALL_TOOL_NAME);
  return exists ? list : [...list, RECALL_TOOL_DEF];
}

/** Normalize an assistant message's tool calls: [{id, name, args}]. */
function collectToolCalls(message) {
  const out = [];
  for (const c of message?.tool_calls ?? []) {
    let args = {};
    try {
      args = JSON.parse(c?.function?.arguments ?? '{}');
    } catch {
      /* malformed arguments — treat as empty */
    }
    out.push({ id: c?.id ?? '', name: c?.function?.name ?? '', args, raw: c });
  }
  return out;
}

/** 'none' | 'content' | 'recall-only' | 'mixed' | 'tools' */
function classifyResponse(message) {
  const calls = collectToolCalls(message);
  if (!calls.length) return message?.content ? 'content' : 'none';
  const recall = calls.filter((c) => c.name === RECALL_TOOL_NAME);
  if (recall.length === calls.length) return 'recall-only';
  return recall.length > 0 ? 'mixed' : 'tools';
}

/**
 * Stateful accumulator for *streamed* chat completions that reconstructs the
 * final assistant message (content + tool_calls + finish_reason) from SSE
 * delta frames, while remembering every raw chunk so the stream can be
 * replayed to the client verbatim if it turns out not to be ours to handle.
 */
function makeToolCallAccumulator() {
  let buf = '';
  let content = '';
  let finishReason = null;
  const chunks = []; // raw Buffers for replay
  const calls = new Map(); // index -> {id, name, arguments}

  return {
    feed(chunk) {
      chunks.push(chunk);
      buf += chunk.toString('utf8');
      const frames = buf.split(/\n\n/);
      buf = frames.pop();
      for (const frame of frames) {
        for (const line of frame.split(/\n/)) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          let j;
          try {
            j = JSON.parse(payload);
          } catch {
            continue;
          }
          const choice = j?.choices?.[0];
          if (!choice) continue;
          if (choice.finish_reason) finishReason = choice.finish_reason;
          const delta = choice.delta ?? choice.message ?? {};
          if (delta.content) content += delta.content;
          for (const tc of delta.tool_calls ?? []) {
            const idx = tc.index ?? 0;
            const cur = calls.get(idx) ?? { id: '', name: '', arguments: '' };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name = tc.function.name;
            if (tc.function?.arguments) cur.arguments += tc.function.arguments;
            calls.set(idx, cur);
          }
        }
      }
    },
    /** Assistant-message shape equivalent to the non-streaming response. */
    message() {
      const tool_calls = [...calls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, c]) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: c.arguments || '{}' },
        }));
      return {
        role: 'assistant',
        content: content || null,
        ...(tool_calls.length ? { tool_calls } : {}),
      };
    },
    get finishReason() {
      return finishReason;
    },
    get sawToolCall() {
      return calls.size > 0;
    },
    get rawChunks() {
      return chunks;
    },
  };
}

/**
 * Build the messages to append when the proxy resolves recall calls itself:
 * the assistant message (as the model produced it) followed by one tool
 * result per call. `results` maps call id -> result text.
 */
function recallExchangeMessages(assistantMessage, callResults) {
  const msgs = [assistantMessage];
  for (const { id, text } of callResults) {
    msgs.push({ role: 'tool', tool_call_id: id, content: text });
  }
  return msgs;
}

module.exports = {
  RECALL_TOOL_NAME,
  RECALL_TOOL_DEF,
  withRecallTool,
  collectToolCalls,
  classifyResponse,
  makeToolCallAccumulator,
  recallExchangeMessages,
};
