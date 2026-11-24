import type { LeadFacts } from '../domain/types.js';

/**
 * Merge newly extracted facts into what we already know (§5.3):
 * - null / empty values never erase existing data
 * - a non-empty new value replaces the old one (customer corrected themselves)
 * Returns only the fields that actually changed.
 */
export function mergeFacts(existing: LeadFacts, incoming: Partial<LeadFacts>): Partial<LeadFacts> {
  const changes: Partial<LeadFacts> = {};
  for (const key of Object.keys(incoming) as (keyof LeadFacts)[]) {
    const value = incoming[key];
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    const normalised = typeof value === 'string' ? value.trim() : value;
    if (existing[key] !== normalised) {
      (changes as Record<string, unknown>)[key] = normalised;
    }
  }
  return changes;
}
