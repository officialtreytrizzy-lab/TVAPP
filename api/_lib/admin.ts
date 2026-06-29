import { createHash, timingSafeEqual } from 'node:crypto';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function bearer(req: any): string {
  const raw = String(req.headers.authorization || '');
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || '';
}

export function requireAdmin(req: any) {
  const provided = bearer(req) || String(req.headers['x-admin-key'] || '').trim();
  const adminKey = process.env.TREY_VIDEO_ADMIN_KEY || '';
  const adminKeyHash = process.env.TREY_VIDEO_ADMIN_KEY_SHA256 || '';

  const allowed = Boolean(
    provided && (
      (adminKey && safeEqual(provided, adminKey)) ||
      (adminKeyHash && safeEqual(sha256(provided), adminKeyHash))
    )
  );

  if (!allowed) {
    const err = new Error('Missing or invalid admin key.');
    (err as any).status = 401;
    (err as any).code = 'admin_unauthorized';
    throw err;
  }
}
