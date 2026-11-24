function parts(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return { y: +p.year!, m: +p.month!, d: +p.day!, h: +p.hour!, min: +p.minute! };
}

/** ISO instant -> "YYYY-MM-DD HH:mm" in the given timezone. */
export function formatLocalDateTime(iso: string | null, timeZone: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const p = parts(date, timeZone);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.y}-${pad(p.m)}-${pad(p.d)} ${pad(p.h)}:${pad(p.min)}`;
}

/**
 * "YYYY-MM-DD HH:mm" or "YYYY-MM-DD" (local time in `timeZone`) -> ISO instant.
 * A bare date means 10:00 local. Returns null for anything else.
 */
export function parseLocalDateTime(text: string, timeZone: string): string | null {
  const m = text.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?$/);
  if (!m) return null;
  const [y, mo, d, h, mi] = [+m[1]!, +m[2]!, +m[3]!, m[4] ? +m[4] : 10, m[5] ? +m[5] : 0];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const wanted = Date.UTC(y, mo - 1, d, h, mi);
  // Find the UTC instant whose local rendering equals the wanted wall-clock time.
  let guess = wanted;
  for (let i = 0; i < 2; i++) {
    const p = parts(new Date(guess), timeZone);
    const rendered = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
    guess += wanted - rendered;
  }
  return new Date(guess).toISOString();
}
