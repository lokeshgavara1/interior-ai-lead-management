import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Inbox } from '../src/engine/inbox.js';
import { buildServer } from '../src/server.js';
import { makeDeps } from './support/fakes.js';

function setup() {
  const ctx = makeDeps();
  const scheduled: string[] = [];
  const inbox = { schedule: (id: string) => scheduled.push(id) } as unknown as Inbox;
  const app = buildServer({ deps: ctx.deps, inbox, metaAppSecret: 'app-secret', metaVerifyToken: 'verify-me' });
  return { ...ctx, app, scheduled };
}

const sign = (body: string) => 'sha256=' + createHmac('sha256', 'app-secret').update(body).digest('hex');

const webhookBody = JSON.stringify({
  object: 'whatsapp_business_account',
  entry: [
    {
      changes: [
        {
          field: 'messages',
          value: {
            metadata: { phone_number_id: 'PNID-1' },
            messages: [{ from: '919876543210', id: 'wamid.X', timestamp: '1763877600', type: 'text', text: { body: 'Hi' } }],
          },
        },
      ],
    },
  ],
});

describe('HTTP routes', () => {
  it('answers the Meta verification handshake', async () => {
    const { app } = setup();
    const ok = await app.inject({ url: '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42' });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('42');
    const bad = await app.inject({ url: '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42' });
    expect(bad.statusCode).toBe(403);
  });

  it('rejects unsigned / wrongly signed webhooks', async () => {
    const { app, repo } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=deadbeef' },
      payload: webhookBody,
    });
    expect(res.statusCode).toBe(401);
    expect(repo.messages).toHaveLength(0);
  });

  it('stores a signed message and schedules processing', async () => {
    const { app, repo, scheduled } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(webhookBody) },
      payload: webhookBody,
    });
    expect(res.statusCode).toBe(200);
    expect(repo.messages).toHaveLength(1);
    expect(scheduled).toHaveLength(1);
  });

  it('website form requires the tenant secret and validates input', async () => {
    const { app } = setup();
    const payload = { customer_name: 'Rahul', phone_number: '9876543210' };
    expect((await app.inject({ method: 'POST', url: '/webhooks/website/demo', payload })).statusCode).toBe(401);
    const bad = await app.inject({
      method: 'POST',
      url: '/webhooks/website/demo',
      headers: { 'x-webhook-secret': 'secret' },
      payload: { phone_number: '9876543210' },
    });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({ method: 'POST', url: '/webhooks/website/demo', headers: { 'x-webhook-secret': 'secret' }, payload });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ created: true });
  });
});
