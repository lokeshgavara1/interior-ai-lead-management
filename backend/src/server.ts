import Fastify, { type FastifyInstance } from 'fastify';
import { parseInstagramWebhook, parseLeadgenWebhook } from './channels/meta.js';
import { parseWhatsAppWebhook } from './channels/whatsapp.js';
import type { EngineDeps } from './engine/deps.js';
import type { Inbox } from './engine/inbox.js';
import {
  ingestInstagramMessage,
  ingestLeadgen,
  ingestWebsiteForm,
  ingestWhatsAppMessage,
  ingestWhatsAppStatus,
  WebsiteFormSchema,
} from './engine/ingest.js';
import { safeEqual, verifyMetaSignature } from './lib/signature.js';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
  }
}

export interface ServerOptions {
  deps: EngineDeps;
  inbox: Inbox;
  metaAppSecret: string;
  metaVerifyToken: string;
  logLevel?: string;
}

export function buildServer(opts: ServerOptions): FastifyInstance {
  const app = Fastify({
    logger: opts.logLevel ? { level: opts.logLevel } : false,
    bodyLimit: 1_000_000,
  });
  const { deps, inbox } = opts;

  // Keep the raw body: Meta signatures are computed over the exact bytes.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    req.rawBody = body as string;
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch (err) {
      (err as { statusCode?: number }).statusCode = 400;
      done(err as Error, undefined);
    }
  });

  app.get('/health', async () => ({ ok: true }));

  // One Meta app webhook serves WhatsApp, Instagram DMs and Facebook Lead Ads.
  // /webhooks/whatsapp is kept as an alias of /webhooks/meta.
  for (const path of ['/webhooks/meta', '/webhooks/whatsapp']) {
    // Verification handshake
    app.get(path, async (req, reply) => {
      const q = req.query as Record<string, string | undefined>;
      if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === opts.metaVerifyToken) {
        return reply.type('text/plain').send(q['hub.challenge'] ?? '');
      }
      return reply.code(403).send();
    });

    // Events
    app.post(path, async (req, reply) => {
      const sig = req.headers['x-hub-signature-256'] as string | undefined;
      if (!req.rawBody || !verifyMetaSignature(req.rawBody, sig, opts.metaAppSecret)) {
        req.log.warn('rejected Meta webhook with invalid signature');
        return reply.code(401).send();
      }
      try {
        const object = (req.body as { object?: string } | undefined)?.object;
        if (object === 'whatsapp_business_account') {
          // Persist before acking (fast DB writes); AI work happens asynchronously.
          const { messages, statuses } = parseWhatsAppWebhook(req.body);
          for (const m of messages) await ingestWhatsAppMessage(deps, inbox, m);
          for (const s of statuses) await ingestWhatsAppStatus(deps, s);
        } else if (object === 'instagram') {
          for (const m of parseInstagramWebhook(req.body)) await ingestInstagramMessage(deps, inbox, m);
        } else if (object === 'page') {
          for (const ev of parseLeadgenWebhook(req.body)) await ingestLeadgen(deps, ev);
        }
      } catch (err) {
        req.log.error({ err }, 'failed to ingest Meta webhook');
        await deps.repo.logError({ operation: 'meta_webhook', message: (err as Error).message });
        return reply.code(500).send(); // Meta will retry; every ingest step is idempotent
      }
      return reply.code(200).send();
    });
  }

  // --- Website enquiry form ---
  // POST /webhooks/website/:tenantSlug  with header  x-webhook-secret: <tenant.website_webhook_secret>
  app.post('/webhooks/website/:tenantSlug', async (req, reply) => {
    const { tenantSlug } = req.params as { tenantSlug: string };
    const tenant = await deps.repo.getTenantBySlug(tenantSlug);
    const secret = req.headers['x-webhook-secret'] as string | undefined;
    if (!tenant || !safeEqual(secret, tenant.website_webhook_secret)) return reply.code(401).send({ error: 'unauthorized' });

    const parsed = WebsiteFormSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid form', fields: parsed.error.issues.map((i) => i.path.join('.')) });
    }
    const result = await ingestWebsiteForm(deps, tenant, parsed.data);
    if ('error' in result) return reply.code(400).send({ error: result.error });
    return reply.code(result.created ? 201 : 200).send({ lead_id: result.lead.lead_id, created: result.created });
  });

  return app;
}
