// Pure functions used by GameRoom. No DO state access — safe to unit-test
// without a Cloudflare runtime.

import { STROKE_INDEX_PAD, STROKE_KEY_PREFIX } from "./constants";

/** Storage key for an individual stroke at `index`. Zero-padded for ordered list(). */
export function strokeKey(index: number): string {
  return STROKE_KEY_PREFIX + String(index).padStart(STROKE_INDEX_PAD, "0");
}

/**
 * Normalize text for answer comparison. Handles common "should match" variants:
 * - NFKC: full-width → half-width, compatibility forms
 * - lowercase: English case-insensitive
 * - strip all whitespace (incl. CJK full-width space U+3000)
 * - strip Unicode punctuation (keeps letters, digits, emoji/symbols)
 *
 * Raw answer is stored as-is so the drawer sees what they typed; normalization
 * runs at compare-time only.
 */
export function normalizeForCompare(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/\s+/g, "").replace(/\p{P}/gu, "");
}
