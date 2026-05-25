# Anamnesis v0.5.0 — Cognitive Loop

**Status:** Draft for review
**Date:** 2026-05-24
**Author:** Fleabag515 + Claude (design pair)
**Targets:** v0.5.0
**Builds on:** v0.4.0 persona system (`a74b390`) and the v0.3.0 audit pass.

---

## 1. Motivation

Anamnesis today stores three layers of episodic state — `turns`, `memcells`,
`memscenes` — plus a parallel `foresights` pipeline and (as of v0.4.0) a
`character_profile` with drift detection. This works, but the model still
sees mostly raw or lightly-clustered recall on every turn. There is no
mechanism by which Anamnesis distils what it has *learned* about the user,
the domain, or itself; and there is no closed-loop signal telling the
retrieval system what was actually useful.

Three problems follow:

1. **Wasted parameters.** A small model running locally (e.g. `qwen3:0.6b`)
   carries no specific knowledge of this user. It re-derives the same
   inferences every turn, from scratch, even though Anamnesis already
   has the raw material to skip that work.
2. **Memory bloat.** As `memcells` and `memscenes` grow, retrieval cost
   creeps up and signal-to-noise drops. Decay helps but does not consolidate.
3. **No feedback loop.** We have no way to tell which retrievals helped
   and which were noise. Decay is purely time- and recall-frequency-based;
   it is not coupled to outcome quality.

The proposal is a **Cognitive Loop**: a new compression tier (`lessons`) on
top of `memscenes`, fed by an automated **reward signal** computed from
each completed turn, surfaced through a **hierarchical retrieval selector**
that allocates the per-request memory budget across four tiers
(`lesson → scene → memcell → turn`) based on query intent.

The vision the design serves: **a small local model + Anamnesis behaves
competitively with a much larger model on long-running personal-assistant
tasks**, by carrying distilled, validated, per-user knowledge in a tight
context window that's reassembled fresh each turn.

## 2. Goals & Non-Goals

### Goals

- Add a `lessons` tier above `memscenes` that stores compact, validated,
  generalised knowledge derived from clusters of related scenes.
- Add an automated reward signal that scores each injected memory item
  based on whether it appears to have helped the resulting response.
- Add a hierarchical selector that chooses how much of each tier to
  inject based on the shape of the current query.
- Make all three feature-flagged and incrementally rolloutable; ship the
  data-model migration so an existing v0.4.0 install upgrades cleanly.
- Co-exist cleanly with the v0.4.0 persona/character system; share
  infrastructure where natural (the post-turn response observer), but
  keep the concepts conceptually distinct.
- Define a small benchmark suite that can demonstrate the "small model +
  Anamnesis ≈ large model alone" claim numerically — separate workstream,
  but in this spec because it justifies the design.

### Non-Goals (v0.5.0)

- A user-facing UI for browsing or editing lessons. Inspector is deferred
  to v0.6.0.
- Cross-instance federation or sync of lessons between Anamnesis nodes.
- Explicit user feedback signals (thumbs-up / thumbs-down). The reward
  loop is fully automated in v0.5.0; explicit feedback is a v0.6+ option.
- Replacing or subsuming the v0.4.0 persona system. Persona stays first-
  class; lessons are an orthogonal tier.
- Re-training or fine-tuning any model.

## 3. Vision and Success Criteria

A user running `qwen3:0.6b` behind Anamnesis for two weeks should observe:

1. The agent's responses cite specific past decisions or preferences that
   were *never explicitly recalled* in the current session.
2. Repeated user corrections ("I already told you it's X") drop measurably
   compared to v0.4.0 baseline.
3. Open foresights are closed at a higher rate.
4. The model's effective context window appears unchanged (4–8K tokens)
   but the perceived "memory horizon" is months.

These are observable from the proxy and become the v0.5.0 telemetry KPIs.

Quantitative success target: on the v0.5.0 internal benchmark (defined in
§13), `qwen3:0.6b + Anamnesis` should match or beat raw `qwen3:0.6b` by
≥30 points on personalisation tasks, and come within ≤15 points of
`llama-3.1-70b` raw on long-horizon recall tasks.

## 4. Architectural Overview

```
   turn ──▶ memcell ──▶ memscene ──▶ lesson         (compression ladder)
     │         │           │           │
     └─────────┴───────────┴───────────┘
                    │
            response observer
            ┌─────────────────────┐
            │  drift check (v0.4) │
            │  reward signal (v0.5)│
            │  foresight closure  │
            └─────────────────────┘
                    │
                   ▼
        importance / decay / precision
        updates to cells, scenes, lessons


           Selector (per request)
   ┌──────────────────────────────────────┐
   │  classify query intent               │
   │  budget = total - system - recency   │
   │  tier 1: lessons (top K)             │
   │  tier 2: scenes  (top K)             │
   │  tier 3: memcells (top K, optional)  │
   │  tier 4: verbatim turns (if budget)  │
   └──────────────────────────────────────┘
                    │
                    ▼
   <character> + <lessons> + <memory> + <foresight>
            + [rotating turns] + [recency]
```

### Where each component lives

| Component                   | New / existing | File                          |
| --------------------------- | -------------- | ----------------------------- |
| `lessons` table             | new            | `src/history.js` (migration)  |
| Lesson distiller            | new            | `src/distiller.js`            |
| Lesson validator (refute)   | new            | `src/distiller.js`            |
| Response observer (router)  | new            | `src/observer.js`             |
| Reward signal computation   | new            | `src/observer.js`             |
| Hierarchical selector       | rewritten      | `src/selector.js`             |
| Query-intent classifier     | new            | `src/lib/intent.js`           |
| Persona drift hook          | unchanged      | `src/persona.js`              |
| Telemetry endpoint additions| new            | `src/proxy.js`                |

Two new modules total (`distiller.js`, `observer.js`); one rewritten
(`selector.js`); one new helper (`lib/intent.js`); minor edits elsewhere.

## 5. Component 1 — Lessons Tier

### 5.1 Conceptual definition

A **lesson** is a short, generalised, validated rule extracted from a
cluster of related `memscenes`. Lessons are *not* summaries — a summary
says "we talked about X." A lesson says "the rule that explains X is Y."

Lessons differ from `memscenes` along three axes:

- **Granularity:** scenes summarise; lessons generalise. A scene is "user
  set up systemd for anamnesis on May 23." A lesson is "this user
  deploys Node services via systemd + NVM under `/home/fleabag/anamnesis/`."
- **Validation:** scenes are write-once; lessons accumulate confirming and
  refuting evidence and can decay or branch.
- **Density:** scenes inject in ~40-80 tokens; lessons in ~15-40 tokens
  but carry far more compressed signal.

Lessons differ from the v0.4.0 **persona profile** along the *who/what*
axis:

- Persona answers "**who** is the agent" — voice, archetype, style markers.
- Lessons answer "**what** has the agent learned" — rules about the world,
  the user's preferences, the domain, the toolchain.

The two coexist in the injected system message; they do not overlap.

### 5.2 Schema

New table `lessons`:

| Column                       | Type    | Notes                                                                    |
| ---------------------------- | ------- | ------------------------------------------------------------------------ |
| `id`                         | INTEGER | PK                                                                       |
| `session_key`                | TEXT    | Matches existing scope; nullable for "global" lessons in a future tier.  |
| `content`                    | TEXT    | The lesson itself, ≤80 words.                                            |
| `embedding`                  | BLOB    | Float32Array; encoded with `embedding_model`.                            |
| `embedding_model`            | TEXT    | Same convention as scenes/cells.                                         |
| `category`                   | TEXT    | technical \| preference \| behaviour \| domain \| other.                 |
| `confidence`                 | REAL    | 0–1; LLM-assigned at generation, updated by reward + refutation.         |
| `supporting_scene_ids`       | TEXT    | JSON array of `memscenes.id`.                                            |
| `supporting_memcell_ids`     | TEXT    | JSON array of `memcells.id`. Set at generation; not maintained on prune. |
| `refute_count`               | INTEGER | Times a contradicting memcell has been observed since last revalidation. |
| `precision_score`            | REAL    | 0–1, EMA of reward-loop signal. Default 0.5.                             |
| `recall_count`               | INTEGER | Number of times injected. Same convention as memcells/scenes.            |
| `last_validated_at`          | INTEGER | unixepoch.                                                                |
| `created_at` / `updated_at`  | INTEGER | unixepoch.                                                                |
| `status`                     | TEXT    | active \| superseded \| retired. Active = injectable.                    |
| `superseded_by`              | INTEGER | FK to `lessons.id` when a branched lesson takes over.                    |

Indices: `(session_key, status, updated_at)` and `(status, precision_score)`.

### 5.3 Generation

A new background job `distiller.runOnce()` runs every
`memory.distillationIntervalMs` (default 600s — 5× consolidation interval)
per session:

1. Fetch scenes that have ≥ `minScenesPerLesson` (default 3) related
   neighbours (cosine ≥ `lessonClusterThreshold`, default 0.78 — slightly
   higher than scene clustering since lessons are coarser).
2. For each cluster, ask an LLM with `LESSON_PROMPT` to either output a
   single lesson (≤80 words, with confidence) **or** the literal token
   `NONE` if the cluster does not support a generalisation.
3. If the LLM outputs a lesson:
   - Compute embedding with the active embedding model.
   - Insert into `lessons` with `confidence` from the LLM, `category`
     classified from the source scenes' modal category, status `active`.
4. Existing lessons are *not* regenerated; instead the cluster grows
   `supporting_scene_ids` only if the lesson already exists and matches.

The `LESSON_PROMPT` is small and concrete:

> Given the following N related observations about an AI assistant's
> ongoing relationship with a user, output a single generalised rule of
> ≤80 words that captures the pattern, OR output `NONE` if no genuine
> generalisation is supported.
>
> Output ONLY valid JSON: `{"content": "…", "confidence": 0.0-1.0, "category": "…"}`
>
> Be conservative. If the observations are too narrow, output `NONE`.

`distiller.runOnce()` follows the same self-rescheduling `setTimeout`
pattern as `consolidator` — never overlap a run.

### 5.4 Validation and refutation

Every time a new `memcell` is inserted, the distiller runs a fast
side-check (no LLM call, no extra HTTP):

1. Embed the cell (already done by `extractor`).
2. For active lessons in the same session with embedding cosine ≥ 0.85,
   compute a cheap textual contradiction probe — substring search for
   known negation markers paired with shared nouns. This is a heuristic
   filter, not a definitive contradiction detector.
3. If the probe fires, increment `lesson.refute_count`. If `refute_count`
   crosses `lessonRefuteThreshold` (default 3), enqueue the lesson for
   LLM-mediated re-validation.

LLM-mediated re-validation (`distiller.refute(lessonId)`):

- Asks: "Given the original lesson and N new contradicting observations,
  which of (a) the lesson still holds, (b) the lesson needs to be revised,
  (c) the lesson is now wrong?"
- (a) → reset `refute_count`, bump `last_validated_at`.
- (b) → generate a successor lesson, mark old `status='superseded'`
  with `superseded_by` set.
- (c) → mark `status='retired'`.

This is what makes the loop feel like belief revision rather than pure
accumulation.

### 5.5 Decay

Lessons decay on a slower timescale than memcells (their whole purpose is
to outlive ephemeral observations). The same decay function is used but
with a longer half-life: `90 + confidence * 180` days vs memcells'
`30 + importance * 60`. Lessons with `recall_count = 0` and `precision_score
< 0.2` after a long idle period are auto-retired.

## 6. Component 2 — Reward Signal

### 6.1 Goal

For every memory item injected into a request, observe — automatically —
whether the resulting response appears to have used and benefited from it.
Feed that signal back into `importance` (cells), `precision_score`
(lessons), and a new `injection_score` rolling average per scene.

### 6.2 Architecture

A new module `src/observer.js` is the single post-turn router. It receives:

- the user message,
- the assistant response,
- the list of items that were injected this turn (lessons, scenes,
  memcells, verbatim turn IDs) — passed in by the selector via a
  per-request `injection_manifest`.

It computes four signals, ensembles them, and writes back. None of these
require user input.

### 6.3 The four signals (v0.5.0)

| Signal              | What it measures                                                                                                                                                          | Cost           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Echo                | Embedding cosine + n-gram overlap between the response and each injected item. High echo on item X ⇒ the model probably used X.                                            | local, ~10ms   |
| No-correction       | Examine the *next* user turn (when it arrives) for correction markers ("no", "actually", "I told you", "wrong"). If detected, all items injected the previous turn lose. | local, ~1ms    |
| Foresight closure   | If this turn marked a previously-open foresight `fulfilled`, items that semantically relate to the foresight target gain.                                                  | local, ~5ms    |
| Latency-to-decision | Response token count divided by time to first token. Confident short answers correlate with good context; long hedged answers with bad. Coarse, but cheap.                | already known  |

Each signal is normalised to `[-1, +1]`. The ensemble is a weighted sum
(weights configurable, sensible defaults). The per-item reward `r` is
clamped to `[-1, +1]`.

### 6.4 Write-back

| Target field                       | Update                                                  |
| ---------------------------------- | ------------------------------------------------------- |
| `memcells.importance`              | EMA toward `0.5 + r * 0.4`, clamp `[0, 1]`.             |
| `memscenes` new `injection_score`  | EMA of `r` (new column added by migration).             |
| `lessons.precision_score`          | EMA of `r`.                                             |
| `lessons.confidence`               | Bumped slightly up on positive r, down on strong neg.   |

The EMA factor is `rewardSmoothing` (default 0.1) — slow enough that a
single noisy turn can't flip a lesson.

### 6.5 Persona/drift integration

The v0.4.0 persona drift check is conceptually the same shape: post-turn,
observe the response, write something back. The observer hosts both:

- `observer.onAssistantTurn(...)` dispatches to:
  - `reward.compute(...)` (new in v0.5.0)
  - `persona.observeResponse(...)` (existing, unchanged)
  - `foresight.tryClose(...)` (existing, lightly tightened)

This consolidates three near-duplicate hooks into one place, but does not
change their semantics.

## 7. Component 3 — Hierarchical Selector

### 7.1 Today

`Selector.select()` does scene-first retrieval, expands to candidate
turns, fills budget. It assumes one "rotating turns" slot pool sized by
`context.rotatingSlots`.

### 7.2 New behaviour

The selector becomes a four-tier budget allocator. Pseudocode:

```js
const budget = tokenBudget - systemReserveTokens - recencyTokens - systemTokens;
const intent = await intent.classify(queryText);  // narrow | broad | reflective
const allocation = budgetAllocation(intent, budget);
// allocation = { lessons, scenes, memcells, turns }
const lessonItems  = retrieveLessons(queryVec, k=allocation.lessons.k, maxTok=allocation.lessons.tok);
const sceneItems   = retrieveScenes( queryVec, k=allocation.scenes.k,  maxTok=allocation.scenes.tok);
const cellItems    = allocation.memcells.tok > 0
  ? retrieveCells(queryVec, ...)
  : [];
const turnItems    = allocation.turns.tok > 0
  ? retrieveTurnsFromScenes(sceneItems, ...)
  : [];
return assembleInjection({ character, lessons: lessonItems, memory: sceneItems, foresight, cells: cellItems, turns: turnItems });
```

### 7.3 Default allocations

| Intent       | Lessons % | Scenes % | Memcells % | Turns % |
| ------------ | --------- | -------- | ---------- | ------- |
| `broad`      | 35        | 35       | 10         | 20      |
| `narrow`     | 15        | 20       | 20         | 45      |
| `reflective` | 50        | 30       | 10         | 10      |

(Percentages of the per-request memory budget — typical 4096 tokens.)

### 7.4 Intent classifier

`src/lib/intent.js` exposes `classify(queryText) → "broad" | "narrow" | "reflective"`.
Two implementations, picked by config:

- `heuristic` (default in v0.5.0-alpha): rule-based — counts question words,
  presence of specific identifiers (file paths, function names, dates),
  presence of reflective markers ("why", "in general", "overall").
- `llm`: one Qwen3:0.6b call with `INTENT_PROMPT`, ~80ms. Used when
  `selector.intent.mode = "llm"`.

The heuristic is good enough to ship; the LLM mode is an opt-in upgrade
and worth measuring.

### 7.5 Injection manifest

The selector emits an `injection_manifest` object alongside the rewritten
messages. The proxy stores it transiently keyed by request, then hands it
to the observer on the post-turn hook. Schema:

```js
{
  request_id: "...",
  intent: "broad",
  items: [
    { kind: "lesson",  id: 17, tokens: 18 },
    { kind: "scene",   id: 92, tokens: 64 },
    { kind: "memcell", id: 4231, tokens: 22 },
    { kind: "turn",    id: 1518, tokens: 280 }
  ]
}
```

This is the data structure that closes the loop — without it, the reward
signal has nothing to credit or blame.

## 8. Data Model Changes

### 8.1 New tables

- `lessons` — see §5.2.
- (No others.)

### 8.2 New columns

| Table       | Column            | Type    | Purpose                          |
| ----------- | ----------------- | ------- | -------------------------------- |
| `memscenes` | `injection_score` | REAL    | EMA from reward loop, default 0.5. |

### 8.3 Migration

Handled in `history.js#_migrate()` following existing conventions. New
columns added with safe defaults so existing v0.4.0 DBs upgrade without
loss.

For an existing DB, lessons are *not* backfilled at migration time. The
distiller will populate them on its first scheduled run after upgrade.

## 9. Configuration

New `config.json` block. All v0.5.0 features are gated by `enabled` flags
so a user can adopt incrementally.

```jsonc
"cognitive": {
  "lessons": {
    "enabled": true,
    "distillationIntervalMs": 600000,
    "minScenesPerLesson": 3,
    "lessonClusterThreshold": 0.78,
    "lessonRefuteThreshold": 3,
    "decayHalfLifeDaysBase": 90,
    "model": "qwen3:0.6b"
  },
  "reward": {
    "enabled": true,
    "weights": { "echo": 0.4, "correction": 0.3, "foresight": 0.2, "latency": 0.1 },
    "smoothing": 0.1
  },
  "selector": {
    "intent": {
      "mode": "heuristic",
      "_modeNote": "heuristic | llm"
    },
    "allocations": {
      "broad":      { "lessons": 0.35, "scenes": 0.35, "memcells": 0.10, "turns": 0.20 },
      "narrow":     { "lessons": 0.15, "scenes": 0.20, "memcells": 0.20, "turns": 0.45 },
      "reflective": { "lessons": 0.50, "scenes": 0.30, "memcells": 0.10, "turns": 0.10 }
    }
  }
}
```

When `cognitive.lessons.enabled = false`, the selector falls back to the
v0.4.0 logic exactly (no lesson tier, single rotating-turn pool). This is
the rollback path.

## 10. Observability

### 10.1 Status endpoint extensions

`GET /anamnesis/status` adds:

```jsonc
{
  "lessons":       42,
  "lessons_active": 38,
  "intent_mix":    { "broad": 0.42, "narrow": 0.51, "reflective": 0.07 },
  "reward_ema":    0.18
}
```

### 10.2 New endpoint: `GET /anamnesis/lessons?limit=20&category=…`

Read-only listing of lessons for debugging. Includes confidence,
precision_score, supporting scene IDs. No edit endpoints in v0.5.0 (per
non-goals).

### 10.3 Logging

A new `[observer]` log line per turn at `ANAMNESIS_LOG=debug`:

```
[observer] turn=4521 intent=broad items=8 reward=+0.34 (echo+0.5, corr+0.0, fore+0.7, lat-0.2)
```

## 11. Testing Strategy

### 11.1 Unit tests (`test/`)

- `lessons.test.js` — schema migration, CRUD, refute_count semantics.
- `distiller.test.js` — clustering logic against fixture scenes; LESSON_PROMPT
  prompt template; happy path + NONE path.
- `observer.test.js` — each of the four signals in isolation, ensemble
  math, EMA writeback, no-correction trigger words.
- `intent.test.js` — heuristic classifier on a hand-curated table of
  ~30 queries.
- `selector.test.js` (rewritten) — allocations math, manifest construction,
  fallback when `cognitive.lessons.enabled = false`.

### 11.2 Integration tests

A new `test/integration/` directory with a small in-memory upstream stub
exercises:

- Full request → selector → upstream stub → observer → DB writeback.
- Verifies that a deliberately-injected lesson that matches the response
  gains `precision_score`, and an injected lesson that the response
  ignores does not.
- Verifies that a correction-pattern in the next user turn drops the
  importance of the prior turn's injections.

### 11.3 Bench harness (separate workstream — see §13)

Lives under `bench/` not `test/`. Runs offline against canned
conversations and a real Ollama; produces a JSON report.

## 12. Rollout Plan

Phased so each phase is independently shippable and reversible.

| Phase | Scope                                                                                                | Default flag state                              |
| ----- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| α     | Schema migration, distiller generates lessons in background, **no injection** yet.                    | `lessons.enabled=true` (silent population)     |
| β     | Selector reads lessons tier under `reflective` intent only.                                          | `selector.intent.mode=heuristic`                |
| γ     | Selector reads lessons across all intents. Reward signal active, but write-back gain capped at 0.05. | `reward.enabled=true`                           |
| 1.0   | Full reward write-back, refutation loop active, intent classifier optionally LLM-mode.               | All defaults from §9.                           |

Each phase is one PR. Each PR is mergeable to main without breaking the
previous behaviour.

## 13. Benchmark Suite (Parallel Workstream)

`bench/`, separate spec but referenced here because it justifies the design.

### 13.1 Task categories

1. **Personalisation** — given a 50-turn fixture conversation in which the
   user expresses N preferences, then a fresh prompt that depends on those
   preferences. Score: how many preferences are correctly honoured.
2. **Long-horizon recall** — given a fixture with a fact mentioned once
   ~100 turns ago, ask for it. Score: exact-match or paraphrase.
3. **Agentic continuity** — given an in-progress task with open foresights,
   resume after a (simulated) session break. Score: does the agent pick
   up where it left off?
4. **Drift resistance** (uses persona system) — over 100 turns of an
   adversarial prompt that pushes against character markers, does the
   character hold?

### 13.2 Configurations to compare

- `qwen3:0.6b` raw
- `qwen3:0.6b` + Anamnesis v0.4.0
- `qwen3:0.6b` + Anamnesis v0.5.0
- `llama-3.1-8b` raw (commodity small-model baseline)
- `llama-3.1-70b` raw (frontier baseline; on the M40 if VRAM permits, else CPU)

### 13.3 Deliverable

A single `bench/REPORT.md` regenerated by `bench/run.sh`. The report is
what we'd link in a blog post or arXiv preprint.

## 14. Risks and Mitigations

| Risk                                                                       | Mitigation                                                                                                              |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Lessons hallucinate rules that aren't actually supported.                  | LESSON_PROMPT requires conservative "NONE" output; refutation loop catches false positives; precision_score gates use.   |
| Reward signal is noisy → memory becomes worse over time.                   | Ensemble is conservative; `smoothing=0.1`; EMA. Phase γ caps write-back at 0.05. Easy to disable via config.             |
| Intent classifier mis-routes a query → wrong allocation.                   | Heuristic mode is overridable per-request via header; LLM mode is opt-in; allocations always include a non-zero turns tier. |
| Distillation interval too aggressive → background LLM load is heavy.       | Default 600s, configurable. Distiller is single-flight via the same guard as consolidator.                              |
| Schema migration breaks an existing v0.4.0 DB.                             | All migrations additive, with safe defaults; existing test covers PRAGMA inspection.                                    |
| Lessons drift from current reality but reward signal hasn't caught up yet. | Refute loop is independent of reward — even a never-injected lesson can be retired by contradicting cells.              |
| Persona system and lessons step on each other (both say "this is how the user is"). | Spec distinguishes WHO (persona) from WHAT/HOW (lessons); both inject side-by-side. If lessons drift into voice territory, refutation will catch them as "low confidence." |

## 15. Out of Scope (Deferred)

- Lesson inspector / editor UI (v0.6.0).
- Explicit user feedback signals (thumbs up/down, "forget this", "lock this").
- Cross-Anamnesis federation / sync.
- A "playbook" tier above lessons (clusters of lessons → composite playbooks).
  Four tiers are enough; we'll revisit only if we see real demand.
- Multi-model embedding (hot small + cold heavy).
- Replay/counterfactual ("what if I'd known X then?").

## 16. Open Questions

1. **Lesson categories.** v0.5.0 uses `technical | preference | behaviour
   | domain | other`. Are these the right axes, or do we steal the existing
   memcell categories (`technical | decision | preference | personal |
   context | other`) for consistency?
2. **Should lessons embed off `content` or off `content + supporting facts`?**
   Embedding off content alone is cheaper and matches retrieval semantics;
   embedding off content + facts is more discriminative. Default: content.
3. **Persona vs lessons overlap policing.** If the distiller starts emitting
   lessons that look like persona rules ("user prefers concise tone"), do we
   prefer to keep them (cheap redundancy) or filter them at generation
   time? Default: keep them, since they reinforce.
4. **No-correction trigger words.** v0.5.0 ships an English-only word list.
   Multilingual support is deferred unless there's user demand.

## 17. Glossary

- **memcell** — atomic fact extracted from an assistant turn.
- **memscene** — thematic cluster of memcells with a title + summary.
- **lesson** — generalised rule extracted from a cluster of memscenes (new in v0.5.0).
- **foresight** — extracted future intention.
- **persona / character profile** — agent identity (v0.4.0).
- **reward signal** — automated per-injected-item utility score (new in v0.5.0).
- **injection manifest** — per-request record of what was injected, used by the observer.
- **precision_score** — EMA of reward signal per lesson; gates further use.
- **intent** — `broad | narrow | reflective`, drives budget allocation.

---

## Appendix A — Why this story sells

A developer evaluating local-LLM memory has two reasons to look at
Anamnesis today: it's a proxy (no library integration) and it's local-first.
v0.5.0 gives them a third reason that's harder to find anywhere else:
**the small model behaves bigger than it has any right to.**

The 30-second demo:

```bash
# fresh install, no setup
$ git clone …/anamnesis && cd anamnesis
$ sudo bash install.sh
# point any OpenAI-compatible client at :8084
# work with qwen3:0.6b for two weeks
$ curl localhost:8084/anamnesis/status
{ "lessons": 42, "reward_ema": +0.31, … }
$ curl localhost:8084/anamnesis/lessons | jq
[
  { "content": "User runs Anamnesis behind OpenClaw on Linux Mint, deploys via systemd + NVM…", "confidence": 0.94 },
  …
]
```

The user sees the agent *change*. They can read the lessons. They can
watch the reward EMA climb. That's the moment they tell a friend.
