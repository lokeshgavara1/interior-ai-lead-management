/**
 * Deterministic opt-out detection, checked BEFORE the AI so a "STOP" is never
 * missed even if the AI is down. The AI also flags softer opt-outs via intent.
 */
const OPT_OUT_PATTERNS = [
  /^\s*(stop|unsubscribe|opt\s*-?\s*out|cancel)\s*[.!]*\s*$/i,
  /\b(stop|don'?t|do not)\s+(messag|text|contact|call)(ing|e|ing me)?\b/i,
  /\bunsubscribe\b/i,
  /\bremove (me|my number)\b/i,
];

export function isOptOut(text: string): boolean {
  return OPT_OUT_PATTERNS.some((re) => re.test(text));
}

/**
 * Explicit requests for a person, checked in code for every model so escalation
 * (spec §12 "Customer asks for human -> escalate") never depends on the AI noticing.
 */
const HUMAN_REQUEST_PATTERNS = [
  /\b(talk|speak|chat|connect)\s+(to|with)\s+(a |an |some )?(real |actual |live )?(person|human|someone|agent|executive|manager|representative|designer|team member|staff|somebody)\b/i,
  /\b(real|actual|live) (person|human|agent)\b/i,
  /\b(not|no) (a )?(bot|robot|ai|machine)\b/i,
  /\bare you (a )?(bot|robot|ai|human|real)\b/i,
  /\b(call me|give me a call|call back|callback|phone me|ring me)\b/i,
  /\b(human|agent|representative) please\b/i,
];

export function isHumanRequest(text: string): boolean {
  return HUMAN_REQUEST_PATTERNS.some((re) => re.test(text));
}

export const OPT_OUT_CONFIRMATION =
  "Understood — you won't receive any more automated messages from us. If you need anything in the future, just message us here.";
