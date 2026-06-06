'use strict';

/**
 * lib/prompts.js — all LLM system prompts in one place.
 *
 * Used by: extractor.js, foresight.js, consolidator.js, persona.js, importers/index.js
 */

const ENGRAM_EXTRACTION = `Extract 3-6 atomic, self-contained facts from this AI assistant turn.

For each fact output a JSON object with:
  "fact": the statement (under 30 words, stands alone without context)
  "importance": 0.0 to 1.0
    1.0 = permanent truth (a decision made, a hard constraint, a user preference)
    0.7 = useful context (a tool chosen, an approach taken)
    0.4 = situational detail (a step done, a value used)
    0.1 = ephemeral (a greeting, a filler statement, a status update)
  "category": one of: technical | decision | preference | personal | context | other

Return ONLY a valid JSON array of objects. No prose. No markdown fences.
If the turn has no extractable facts, return [].

TURN:
`;

const FORESIGHT = `Scan this AI assistant turn for future intentions — things the assistant or user plans to do, build, fix, or try.

For each genuine intention output a JSON object with:
  "intention": short description of what will be done (≤25 words)
  "target":    specific target — file, tool, project, system (empty string if none)
  "timeframe": one of: soon | days | weeks | months | ongoing
  "confidence": 0.0 to 1.0
    1.0 = definite plan ("I will now...", "next step is...", "let's do X")
    0.7 = likely plan ("we should...", "I'll probably...", "plan to...")
    0.4 = vague possibility ("might", "could", "maybe")
    below 0.4 = skip entirely

Return ONLY a valid JSON array. No prose. No markdown fences. Empty array [] if nothing found.

TURN:
`;

// Used by consolidator._generateScene() — generates {title, summary} for an episode cluster.
const EPISODE_SCENE = `You are a memory organizer. Given a list of related facts, create:
1. A short scene title (3-6 words, like a chapter heading)
2. A single summary sentence tying the facts together

Output ONLY valid JSON in this exact format:
{"title": "...", "summary": "..."}

Facts:
`;

// Used by persona._extractProfile()
const PERSONA_EXTRACT = `You are extracting a compact character profile from an agent identity document.
Return ONLY valid JSON — no markdown fences, no explanation.

JSON schema:
{
  "name": "agent name",
  "archetype": "one-sentence core identity",
  "vibe": "personality tone descriptors (comma-separated)",
  "style_markers": ["distinctive phrases or words this agent uses"],
  "behavioral_patterns": ["how they approach tasks and interaction"],
  "relationship": "relationship context with their user (one sentence)"
}

SOURCE DOCUMENT:
`;

// Used by persona._runDriftCheck()
const PERSONA_DRIFT = `You are checking if an AI assistant response is consistent with its character profile.
Return ONLY valid JSON — no markdown fences, no explanation.

{
  "consistent": 0.0,
  "missing": ["style markers or traits absent from this response"],
  "novel": ["new behaviors or phrases not in the profile but observed here"]
}
"consistent" is 0.0 (total drift) to 1.0 (perfect consistency).

CHARACTER PROFILE:
`;

// Used by persona._consolidateGrowth()
const PERSONA_EVOLUTION = `You are updating an AI character's evolution notes based on recent observations.
Write 2–4 sentences describing what has genuinely changed or grown in this character recently.
Focus on concrete new patterns, not vague generalities. Return ONLY the prose — no JSON, no headers.

CURRENT EVOLUTION NOTES (may be empty):
`;

// Used by importers/index.js llmExtract()
const IMPORT_EXTRACTION = `You are extracting a character profile from source material.
Return ONLY valid JSON with these fields (all optional, omit if unknown):
{ "name": string, "personality": string, "speaking_style": string, "backstory": string, "relationships": string, "other": string }
No markdown fences. No explanation.`;

module.exports = {
  ENGRAM_EXTRACTION,
  FORESIGHT,
  EPISODE_SCENE,
  PERSONA_EXTRACT,
  PERSONA_DRIFT,
  PERSONA_EVOLUTION,
  IMPORT_EXTRACTION,
};
