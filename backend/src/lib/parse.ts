const UNIT: Record<string, number> = {
  l: 1e5,
  lac: 1e5,
  lacs: 1e5,
  lakh: 1e5,
  lakhs: 1e5,
  cr: 1e7,
  crore: 1e7,
  crores: 1e7,
  k: 1e3,
  thousand: 1e3,
};

/**
 * Parse a free-text Indian budget into rupees.
 * "8 lakhs" -> 800000, "₹8,00,000" -> 800000, "10-15 lakhs" -> 1250000, "1.2 cr" -> 12000000.
 */
export function parseBudgetInr(text: string | null | undefined): number | null {
  if (!text) return null;
  const s = text
    .toLowerCase()
    .replace(/,/g, '')
    .replace(/₹|\brs\b\.?|\binr\b/g, ' ');
  const m = s.match(/(\d+(?:\.\d+)?)(?:\s*(?:-|to|–)\s*(\d+(?:\.\d+)?))?\s*(lakhs?|lacs?|l|crores?|cr|k|thousand)?\b/);
  if (!m) return null;
  const a = Number(m[1]);
  const b = m[2] ? Number(m[2]) : a;
  const unit = m[3] ? (UNIT[m[3]] ?? 1) : 1;
  const value = Math.round(((a + b) / 2) * unit);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Map free text like "Independent House" onto an enum value ("independent_house"). */
export function toEnum<T extends string>(value: string | null | undefined, allowed: readonly T[], aliases: Record<string, T> = {}): T | null {
  if (!value) return null;
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if ((allowed as readonly string[]).includes(key)) return key as T;
  for (const [alias, target] of Object.entries(aliases)) {
    if (key.includes(alias)) return target;
  }
  return null;
}
