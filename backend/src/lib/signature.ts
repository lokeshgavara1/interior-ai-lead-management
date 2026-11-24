import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify Meta's X-Hub-Signature-256 header ("sha256=<hex>") against the raw
 * request body. Must use the exact raw bytes Meta sent, not re-serialised JSON.
 */
export function verifyMetaSignature(rawBody: string | Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const received = header.slice('sha256='.length);
  if (received.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(received, 'hex'), Buffer.from(expected, 'hex'));
}

/** Constant-time comparison for shared secrets (website webhook). */
export function safeEqual(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
