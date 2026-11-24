const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function ymd(y: number, m: number, d: number): string {
  const dt = new Date(Date.UTC(y, m, d));
  return dt.toISOString().slice(0, 10);
}

/**
 * Resolve what a customer said about timing into a start date (YYYY-MM-DD), relative
 * to `today` (YYYY-MM-DD in the business's timezone). Deterministic, so the 30-day
 * scoring rule never depends on the AI's date arithmetic. Returns null if unsure.
 *
 *   "immediately" / "asap" / "now"      -> today
 *   "this week" / "next week"           -> today / +7 days
 *   "this month" / "next month"         -> today / 1st of next month
 *   "in 2 weeks", "after 3 months"      -> today + N
 *   "in March", "January 2027"          -> 1st of that month (next occurrence)
 */
export function resolveTimeline(text: string | null | undefined, today: string): string | null {
  if (!text) return null;
  const s = text.toLowerCase();
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  const mi = m - 1;

  if (/\b(immediately|asap|right away|right now|now|urgent(ly)?|today|this week)\b/.test(s)) {
    return /\bthis week\b/.test(s) || !/\bnot\b/.test(s) ? today : null;
  }
  if (/\btomorrow\b/.test(s)) return ymd(y, mi, d + 1);
  if (/\bnext week\b/.test(s)) return ymd(y, mi, d + 7);
  if (/\bthis month\b/.test(s)) return today;
  if (/\bnext month\b/.test(s)) return ymd(y, mi + 1, 1);
  if (/\bnext year\b/.test(s)) return ymd(y + 1, 0, 1);

  const rel = s.match(/\b(?:in|after|within)\s+(\d+|a|an|one|two|three|four|five|six)\s+(day|week|month)s?\b/);
  if (rel) {
    const words: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
    const n = words[rel[1]!] ?? Number(rel[1]);
    if (rel[2] === 'day') return ymd(y, mi, d + n);
    if (rel[2] === 'week') return ymd(y, mi, d + 7 * n);
    return ymd(y, mi + n, d);
  }

  // Month names only in a timing context ("in March", "from jan", "June 2027", or just "March"),
  // so "I may start soon" is not read as May.
  const M = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*';
  const month =
    s.match(new RegExp(`\\b(?:in|from|by|after|around|starting|start|during|end of|mid)\\s+${M}\\b(?:\\s+(\\d{4}))?`)) ??
    s.match(new RegExp(`\\b${M}\\s+(\\d{4})\\b`)) ??
    s.trim().match(new RegExp(`^${M}()$`));
  if (month) {
    const idx = MONTHS.indexOf(month[1]!);
    const year = month[2] ? Number(month[2]) : idx < mi ? y + 1 : y;
    return idx === mi && !month[2] ? today : ymd(year, idx, 1);
  }
  return null;
}
