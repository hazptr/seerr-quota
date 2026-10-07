import { describe, expect, it } from 'vitest';
import { GET } from '@/app/healthz/route';
import { APP_VERSION } from '@/lib/version';

describe('GET /healthz (unauthenticated liveness, no identity resolution, no upstream call)', () => {
  it('returns the documented shape and status, including the running version', async () => {
    const res = GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: 'ok', service: 'seerr-quota', version: APP_VERSION });
  });

  it('does not import anything from src/lib/auth (no identity resolution in the handler module)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const source = fs.readFileSync(path.join(process.cwd(), 'src/app/healthz/route.ts'), 'utf-8');
    expect(source).not.toMatch(/lib\/auth/);
  });
});
