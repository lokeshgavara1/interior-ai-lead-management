import { toWhatsAppId } from '../lib/phone.js';

// ---------------------------------------------------------------------------
// Inbound webhook parsing
// ---------------------------------------------------------------------------

export interface WaInboundMessage {
  phoneNumberId: string; // which business number received it -> tenant
  from: string; // customer wa_id (digits, with country code)
  profileName: string | null;
  messageId: string; // wamid — idempotency key
  timestamp: string; // ISO
  text: string;
  type: string;
}

export interface WaStatusUpdate {
  phoneNumberId: string;
  messageId: string;
  status: string; // sent / delivered / read / failed
}

/** Text we store for non-text messages (initial release supports text only). */
function describeNonText(msg: Record<string, any>): string {
  switch (msg.type) {
    case 'image':
      return `[Customer sent an image${msg.image?.caption ? `: ${msg.image.caption}` : ''}]`;
    case 'document':
      return `[Customer sent a document${msg.document?.filename ? `: ${msg.document.filename}` : ''}]`;
    case 'audio':
      return '[Customer sent a voice message]';
    case 'video':
      return '[Customer sent a video]';
    case 'location':
      return `[Customer shared a location: ${msg.location?.name ?? ''} ${msg.location?.address ?? ''}]`.trim();
    case 'button':
      return msg.button?.text ?? '[Button reply]';
    case 'interactive':
      return msg.interactive?.button_reply?.title ?? msg.interactive?.list_reply?.title ?? '[Interactive reply]';
    default:
      return `[Unsupported message type: ${msg.type}]`;
  }
}

export function parseWhatsAppWebhook(body: any): { messages: WaInboundMessage[]; statuses: WaStatusUpdate[] } {
  const messages: WaInboundMessage[] = [];
  const statuses: WaStatusUpdate[] = [];
  if (body?.object !== 'whatsapp_business_account') return { messages, statuses };

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'messages') continue;
      const value = change.value ?? {};
      const phoneNumberId: string | undefined = value.metadata?.phone_number_id;
      if (!phoneNumberId) continue;
      const names = new Map<string, string>();
      for (const c of value.contacts ?? []) if (c.wa_id && c.profile?.name) names.set(c.wa_id, c.profile.name);

      for (const m of value.messages ?? []) {
        if (!m.id || !m.from) continue;
        const text = m.type === 'text' ? String(m.text?.body ?? '') : describeNonText(m);
        if (!text.trim()) continue;
        messages.push({
          phoneNumberId,
          from: m.from,
          profileName: names.get(m.from) ?? null,
          messageId: m.id,
          timestamp: new Date(Number(m.timestamp ?? Date.now() / 1000) * 1000).toISOString(),
          text,
          type: m.type,
        });
      }
      for (const s of value.statuses ?? []) {
        if (s.id && s.status) statuses.push({ phoneNumberId, messageId: s.id, status: s.status });
      }
    }
  }
  return { messages, statuses };
}

// ---------------------------------------------------------------------------
// Outbound
// ---------------------------------------------------------------------------

export interface WhatsAppSender {
  sendText(phoneNumberId: string, toE164: string, body: string): Promise<string>;
  sendTemplate(phoneNumberId: string, toE164: string, template: string, lang: string, bodyParams: string[]): Promise<string>;
}

export class WhatsAppApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
  ) {
    super(message);
  }
}

export function createWhatsAppSender(accessToken: string, graphVersion: string): WhatsAppSender {
  async function post(phoneNumberId: string, payload: Record<string, unknown>): Promise<string> {
    const url = `https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
          signal: AbortSignal.timeout(15_000),
        });
        const json: any = await res.json().catch(() => ({}));
        if (res.ok) return json.messages?.[0]?.id ?? '';
        const err = new WhatsAppApiError(json.error?.message ?? `HTTP ${res.status}`, res.status, json.error?.code);
        // Retry only on rate limits / server errors; 4xx (bad number, outside 24h window) won't fix itself.
        if (res.status !== 429 && res.status < 500) throw err;
        lastErr = err;
      } catch (err) {
        if (err instanceof WhatsAppApiError && err.status !== 429 && err.status < 500) throw err;
        lastErr = err;
      }
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
    throw lastErr;
  }

  return {
    sendText(phoneNumberId, toE164, body) {
      return post(phoneNumberId, { to: toWhatsAppId(toE164), type: 'text', text: { body, preview_url: false } });
    },
    sendTemplate(phoneNumberId, toE164, template, lang, bodyParams) {
      return post(phoneNumberId, {
        to: toWhatsAppId(toE164),
        type: 'template',
        template: {
          name: template,
          language: { code: lang },
          components: bodyParams.length
            ? [{ type: 'body', parameters: bodyParams.map((text) => ({ type: 'text', text })) }]
            : [],
        },
      });
    },
  };
}

/** WhatsApp only allows free-form messages within 24h of the customer's last message. */
export function isWithinServiceWindow(lastCustomerMessageAt: string | null, now: Date = new Date()): boolean {
  if (!lastCustomerMessageAt) return false;
  return now.getTime() - new Date(lastCustomerMessageAt).getTime() < 24 * 60 * 60 * 1000 - 5 * 60 * 1000;
}
