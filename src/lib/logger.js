/**
 * lib/logger.js — small, dependency-free logger.
 *
 * Levels:
 *   error | warn | info | debug
 *
 * Defaults to "info". Set ANAMNESIS_LOG=debug to enable per-request selector
 * tracing and similar high-frequency lines, or ANAMNESIS_LOG=warn to quiet
 * down for production deployments.
 *
 * Each logger carries a short tag printed in square brackets, mirroring the
 * existing `[anamnesis] …`, `[selector] …`, etc. lines.
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const ACTIVE = LEVELS[(process.env.ANAMNESIS_LOG ?? 'info').toLowerCase()] ?? LEVELS.info;

function make(tag) {
  const prefix = `[${tag}]`;
  return {
    error: (...args) => { if (ACTIVE >= LEVELS.error) console.error(prefix, ...args); },
    warn:  (...args) => { if (ACTIVE >= LEVELS.warn)  console.warn(prefix,  ...args); },
    info:  (...args) => { if (ACTIVE >= LEVELS.info)  console.log(prefix,   ...args); },
    debug: (...args) => { if (ACTIVE >= LEVELS.debug) console.log(prefix,   ...args); },
  };
}

module.exports = { make, LEVELS, ACTIVE };
