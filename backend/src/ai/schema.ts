import { z } from 'zod';
import { PROJECT_TYPES, PROPERTY_STATUSES, PROPERTY_TYPES } from '../domain/types.js';

export const INTENTS = [
  'new_enquiry',
  'provide_info',
  'pricing_question',
  'site_visit_request',
  'ready_to_proceed',
  'human_request',
  'opt_out',
  'general_question',
  'complaint',
  'other',
] as const;

/** Spec §9.2, tightened: enums instead of free text, null for unknown. */
export const AiTurnSchema = z.object({
  reply: z.string().min(1).max(1000),
  intent: z.enum(INTENTS),
  customer_name: z.string().nullable(),
  phone_number: z.string().nullable(),
  email: z.string().nullable(),
  location: z.string().nullable(),
  property_type: z.enum(PROPERTY_TYPES).nullable(),
  property_size: z.string().nullable(),
  project_type: z.enum(PROJECT_TYPES).nullable(),
  budget: z.number().nonnegative().nullable(),
  property_status: z.enum(PROPERTY_STATUSES).nullable(),
  timeline_text: z.string().nullable(),
  expected_start_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  requirements: z.string().nullable(),
  site_visit_requested: z.boolean(),
  needs_human: z.boolean(),
  human_reason: z.string().nullable(),
  missing_information: z.array(z.string()),
});

export type AiTurn = z.infer<typeof AiTurnSchema>;

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] });
const str = { type: 'string' };

/**
 * JSON Schema sent to OpenAI structured outputs (strict mode: every property
 * required, no additional properties). Kept in sync with AiTurnSchema by test.
 */
export const AI_TURN_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'reply',
    'intent',
    'customer_name',
    'phone_number',
    'email',
    'location',
    'property_type',
    'property_size',
    'project_type',
    'budget',
    'property_status',
    'timeline_text',
    'expected_start_date',
    'requirements',
    'site_visit_requested',
    'needs_human',
    'human_reason',
    'missing_information',
  ],
  properties: {
    reply: { type: 'string', description: 'Message to send to the customer, in their language.' },
    intent: { type: 'string', enum: [...INTENTS] },
    customer_name: nullable(str),
    phone_number: nullable({ type: 'string', description: 'Phone/WhatsApp number the customer typed in the chat.' }),
    email: nullable(str),
    location: nullable({ type: 'string', description: 'Area and city of the property.' }),
    property_type: nullable({ type: 'string', enum: [...PROPERTY_TYPES] }),
    property_size: nullable({ type: 'string', description: 'e.g. 2BHK, 3BHK, 1800 sqft' }),
    project_type: nullable({ type: 'string', enum: [...PROJECT_TYPES] }),
    budget: nullable({ type: 'number', description: 'Budget in INR as a plain number. 8 lakhs = 800000.' }),
    property_status: nullable({ type: 'string', enum: [...PROPERTY_STATUSES] }),
    timeline_text: nullable({ type: 'string', description: "Customer's words about timing, e.g. 'next month'." }),
    expected_start_date: nullable({ type: 'string', description: 'Resolved start date YYYY-MM-DD, relative to today.' }),
    requirements: nullable({ type: 'string', description: 'Rooms / items wanted, comma separated.' }),
    site_visit_requested: { type: 'boolean' },
    needs_human: { type: 'boolean' },
    human_reason: nullable(str),
    missing_information: { type: 'array', items: { type: 'string' } },
  },
} as const;
