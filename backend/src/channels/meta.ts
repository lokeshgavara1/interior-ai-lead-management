/**
 * Instagram Direct Messages (spec §3.3) and Facebook Lead Ads (spec §3.4),
 * via the Meta Graph API using the tenant's Facebook Page access token.
 * Both arrive on the same Meta app webhook as WhatsApp (signed with the app secret).
 */

// ---------------------------------------------------------------------------
// Instagram DM webhook parsing (object = "instagram")
// ---------------------------------------------------------------------------

export interface IgInboundMessage {
  igAccountId: string; // business account that received it -> tenant
  senderId: string; // customer's Instagram-scoped id (IGSID)
  messageId: string; // mid — idempotency key
  timestamp: string; // ISO
  text: string;
}

function describeAttachments(attachments: any[] | undefined): string | null {
  if (!attachments?.length) return null;
  const types = attachments.map((a) => a?.type ?? 'file');
  if (types.includes('image')) return '[Customer sent an image]';
  if (types.includes('video')) return '[Customer sent a video]';
  if (types.includes('audio')) return '[Customer sent a voice message]';
  if (types.includes('share') || types.includes('story_mention')) return '[Customer shared a post/story]';
  return `[Customer sent: ${types.join(', ')}]`;
}

export function parseInstagramWebhook(body: any): IgInboundMessage[] {
  const out: IgInboundMessage[] = [];
  if (body?.object !== 'instagram') return out;
  for (const entry of body.entry ?? []) {
    const igAccountId = String(entry.id ?? '');
    for (const ev of entry.messaging ?? []) {
      const msg = ev.message;
      if (!msg?.mid || !ev.sender?.id) continue; // reads, reactions, postbacks without message
      if (msg.is_echo || ev.sender.id === igAccountId) continue; // our own outgoing messages
      if (msg.is_deleted || msg.is_unsupported) continue;
      const text = (typeof msg.text === 'string' && msg.text.trim()) || describeAttachments(msg.attachments);
      if (!text) continue;
      out.push({
        igAccountId: igAccountId || String(ev.recipient?.id ?? ''),
        senderId: String(ev.sender.id),
        messageId: String(msg.mid),
        timestamp: new Date(Number(ev.timestamp ?? Date.now())).toISOString(),
        text,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lead Ads webhook parsing (object = "page", field = "leadgen")
// ---------------------------------------------------------------------------

export interface LeadgenEvent {
  pageId: string;
  leadgenId: string;
  formId: string | null;
}

export function parseLeadgenWebhook(body: any): LeadgenEvent[] {
  const out: LeadgenEvent[] = [];
  if (body?.object !== 'page') return out;
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'leadgen') continue;
      const v = change.value ?? {};
      if (!v.leadgen_id) continue;
      out.push({ pageId: String(v.page_id ?? entry.id), leadgenId: String(v.leadgen_id), formId: v.form_id ? String(v.form_id) : null });
    }
  }
  return out;
}

export interface LeadgenData {
  created_time?: string;
  form_id?: string;
  field_data: { name: string; values: string[] }[];
}

// ---------------------------------------------------------------------------
// Graph API client
// ---------------------------------------------------------------------------

export interface MetaGraph {
  sendInstagramText(pageToken: string, recipientIgsid: string, text: string): Promise<string>;
  fetchLeadgen(pageToken: string, leadgenId: string): Promise<LeadgenData>;
}

export class MetaApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function createMetaGraph(graphVersion: string): MetaGraph {
  const base = `https://graph.facebook.com/${graphVersion}`;

  async function call(method: 'GET' | 'POST', path: string, token: string, body?: unknown): Promise<any> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(`${base}${path}`, {
          method,
          headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(15_000),
        });
        const json: any = await res.json().catch(() => ({}));
        if (res.ok) return json;
        const err = new MetaApiError(json.error?.message ?? `HTTP ${res.status}`, res.status);
        if (res.status !== 429 && res.status < 500) throw err;
        lastErr = err;
      } catch (err) {
        if (err instanceof MetaApiError && err.status !== 429 && err.status < 500) throw err;
        lastErr = err;
      }
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
    throw lastErr;
  }

  return {
    async sendInstagramText(pageToken, recipientIgsid, text) {
      const json = await call('POST', '/me/messages', pageToken, { recipient: { id: recipientIgsid }, message: { text } });
      return String(json.message_id ?? '');
    },
    async fetchLeadgen(pageToken, leadgenId) {
      const json = await call('GET', `/${encodeURIComponent(leadgenId)}?fields=created_time,form_id,field_data`, pageToken);
      return { created_time: json.created_time, form_id: json.form_id, field_data: json.field_data ?? [] };
    },
  };
}
