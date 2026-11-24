import type { LeadFacts, LeadStatus, Temperature } from '../domain/types.js';
import { SALES_OWNED_STATUSES } from '../domain/types.js';

/** Spec §6.1 — deterministic, never decided by the AI. */
export const SCORE_RULES = {
  budgetProvided: 20,
  propertyReady: 20,
  startsWithin30Days: 25,
  siteVisitRequested: 20,
  fullHome: 15,
} as const;

export interface ScoreInput extends Pick<LeadFacts, 'budget' | 'property_status' | 'expected_start_date' | 'project_type'> {
  site_visit_requested: boolean;
}

export interface ScoreResult {
  score: number;
  temperature: Temperature;
  /** Points still possible from facts we don't know yet. */
  unknownPoints: number;
  breakdown: Record<keyof typeof SCORE_RULES, number>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function band(score: number): Exclude<Temperature, 'provisional'> {
  if (score >= 70) return 'hot';
  if (score >= 40) return 'warm';
  return 'cold';
}

/**
 * Score a lead and classify it (§6.2).
 *
 * "If insufficient information is available, keep the lead provisional rather than
 * incorrectly marking it cold": we compute the lowest possible score (known facts only)
 * and the highest possible score (if every unknown fact turned out favourable). The lead
 * is only classified when both land in the same band.
 */
export function scoreLead(input: ScoreInput, now: Date = new Date()): ScoreResult {
  const breakdown = { budgetProvided: 0, propertyReady: 0, startsWithin30Days: 0, siteVisitRequested: 0, fullHome: 0 };
  let unknownPoints = 0;

  if (input.budget != null && input.budget > 0) breakdown.budgetProvided = SCORE_RULES.budgetProvided;
  else unknownPoints += SCORE_RULES.budgetProvided;

  if (input.property_status === 'ready') breakdown.propertyReady = SCORE_RULES.propertyReady;
  else if (input.property_status == null) unknownPoints += SCORE_RULES.propertyReady;

  if (input.expected_start_date) {
    const start = new Date(`${input.expected_start_date}T00:00:00Z`).getTime();
    if (!Number.isNaN(start) && start - now.getTime() <= 30 * DAY_MS) {
      breakdown.startsWithin30Days = SCORE_RULES.startsWithin30Days;
    }
  } else {
    unknownPoints += SCORE_RULES.startsWithin30Days;
  }

  // Site visit is an event, not a fact: false means "not requested (yet)".
  if (input.site_visit_requested) breakdown.siteVisitRequested = SCORE_RULES.siteVisitRequested;

  if (input.project_type === 'full_home') breakdown.fullHome = SCORE_RULES.fullHome;
  else if (input.project_type == null) unknownPoints += SCORE_RULES.fullHome;

  const score = Object.values(breakdown).reduce((a, b) => a + b, 0);
  const low = band(score);
  const high = band(Math.min(100, score + unknownPoints));
  return { score, temperature: low === high ? low : 'provisional', unknownPoints, breakdown };
}

/** Facts needed before a lead counts as "qualified". */
export const REQUIRED_FACTS = ['location', 'property_type', 'project_type', 'property_status', 'budget', 'timeline'] as const;

export function missingFacts(f: LeadFacts): string[] {
  const missing: string[] = [];
  if (!f.location) missing.push('location');
  if (!f.property_type) missing.push('property_type');
  if (!f.project_type) missing.push('project_type');
  if (!f.property_status) missing.push('property_status');
  if (f.budget == null) missing.push('budget');
  if (!f.expected_start_date && !f.timeline_text) missing.push('timeline');
  return missing;
}

/**
 * Pipeline status (§6.3) is separate from temperature. Automation only moves leads
 * between new / information_pending / qualified; later stages belong to sales.
 */
export function deriveStatus(current: LeadStatus, f: LeadFacts): LeadStatus {
  if (SALES_OWNED_STATUSES.includes(current)) return current;
  const missing = missingFacts(f);
  if (missing.length === 0) return 'qualified';
  if (missing.length === REQUIRED_FACTS.length) return 'new';
  return 'information_pending';
}
