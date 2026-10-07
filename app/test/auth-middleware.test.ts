import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { config as middlewareConfig, middleware } from '@/middleware';
import { _resetConfigCacheForTests } from '@/lib/config';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  _resetConfigCacheForTests();
});

function req(pathname: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(new Request(`http://localhost${pathname}`, { headers }));
}

describe('middleware (FR-SSO-2): 401 on any request lacking Remote-User', () => {
  it('401s a request with no Remote-User header at all', () => {
    const res = middleware(req('/'));
    expect(res.status).toBe(401);
  });

  it('401s a whitespace-only Remote-User header', () => {
    const res = middleware(req('/', { 'Remote-User': '   ' }));
    expect(res.status).toBe(401);
  });

  it(
    'the check is unconditional — nothing in the request (including how it "arrived") changes the outcome; ' +
      'this is what FR-SSO-2\'s "including requests arriving on the loopback port" means at the app layer: ' +
      'the loopback bind (docker-compose.yml) is a network-level backstop, this middleware is the actual control ' +
      'and has no branch that would ever skip the check based on origin',
    () => {
      // Two structurally identical requests to two different paths a
      // loopback-port caller might hit directly — both still 401 with no
      // Remote-User, proving there's no special-cased bypass.
      expect(middleware(req('/')).status).toBe(401);
      expect(middleware(req('/api/whoami')).status).toBe(401);
    },
  );

  it('passes a request through (NextResponse.next()) when Remote-User is present', () => {
    const res = middleware(req('/', { 'Remote-User': 'dana' }));
    expect(res.status).toBe(200);
    // NextResponse.next() is marked with this internal header — distinguishes
    // "let the request continue" from a real 200 JSON response.
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });

  it('member and operator both pass the gate the same way (role is not checked here — that is FR-SSO-5, per-route)', () => {
    expect(middleware(req('/', { 'Remote-User': 'dana' })).headers.get('x-middleware-next')).toBe('1');
    expect(middleware(req('/', { 'Remote-User': 'admin' })).headers.get('x-middleware-next')).toBe('1');
  });
});

describe('middleware (FR-SSO-3): mixed-case username and | / , groups resolve through the real config', () => {
  it('a mixed-case ADMIN_USERS match still passes the gate (role resolution happens downstream via getIdentity(), not here)', () => {
    process.env.ADMIN_USERS = 'admin';
    _resetConfigCacheForTests();
    const res = middleware(req('/', { 'Remote-User': 'Admin', 'Remote-Groups': 'ops|extra,more' }));
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });

  it('empty Remote-Groups never crashes the gate', () => {
    const res = middleware(req('/', { 'Remote-User': 'dana' }));
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });
});

describe('middleware (FR-SSO-4): a client-supplied Remote-User cannot escalate via a second code path', () => {
  it(
    'src/middleware.ts reads ONLY the exact header names Remote-User/Remote-Groups — there is no fallback ' +
      '(no X-Remote-User, no X-Forwarded-User, no cookie) a client could use to sneak identity past a correctly ' +
      "configured nginx that only overwrites those two names. This is what FR-SSO-4 requires of the APP's code — " +
      'nginx unconditionally overwriting Remote-User/Remote-Groups (in the reverse-proxy vhost config, ' +
      "not this app) is the actual anti-spoofing control; this test proves the app never adds a " +
      'second, weaker one next to it.',
    () => {
      const source = fs.readFileSync(path.join(process.cwd(), 'src/middleware.ts'), 'utf-8');
      const headerReads = [...source.matchAll(/req\.headers\.get\((['"`])([^'"`]+)\1\)/g)].map((m) => m[2]);
      expect(headerReads.sort()).toEqual(['Remote-Groups', 'Remote-User']);
    },
  );

  it(
    'a request presenting Remote-User: admin is trusted verbatim by the app (expected — the app cannot ' +
      'distinguish a SWAG-authored header from a spoofed one; that distinction is nginx\'s job, not this ' +
      "middleware's). This documents the boundary rather than a gap: production safety depends on nginx's " +
      'unconditional proxy_set_header + the loopback bind, neither of which this unit test can exercise.',
    () => {
      const res = middleware(req('/', { 'Remote-User': 'admin' }));
      expect(res.headers.get('x-middleware-next')).toBe('1');
    },
  );
});

describe('middleware matcher — /healthz is exempt (FR-SSO-6) and /api/seerr/webhook is exempt (FR-SSO-7)', () => {
  // The matcher string is Next's documented negative-lookahead regex idiom;
  // Next compiles it as a regular expression against the pathname, so
  // exercising it directly here proves the same thing an HTTP request
  // through Next's router would (a defensive-depth idiom, same as its equivalent
  // test for the same matcher shape).
  const [pattern] = middlewareConfig.matcher;
  const matcherRegex = new RegExp(`^${pattern}$`);

  function isExcludedFromGate(pathname: string): boolean {
    return !matcherRegex.test(pathname);
  }

  it('excludes /healthz itself and a sub-path', () => {
    expect(isExcludedFromGate('/healthz')).toBe(true);
    expect(isExcludedFromGate('/healthz/')).toBe(true);
  });

  it('does NOT exclude a similarly-prefixed route (path-segment anchoring, not a bare prefix match)', () => {
    expect(isExcludedFromGate('/healthz-status')).toBe(false);
  });

  it('excludes /api/seerr/webhook itself and a sub-path', () => {
    expect(isExcludedFromGate('/api/seerr/webhook')).toBe(true);
    expect(isExcludedFromGate('/api/seerr/webhook/')).toBe(true);
  });

  it('does NOT exclude a similarly-prefixed route under /api/seerr/', () => {
    expect(isExcludedFromGate('/api/seerr/webhook-evil')).toBe(false);
    expect(isExcludedFromGate('/api/seerr/other')).toBe(false);
  });

  it('still excludes the Next internals and favicon', () => {
    expect(isExcludedFromGate('/_next/static/chunk.js')).toBe(true);
    expect(isExcludedFromGate('/_next/image')).toBe(true);
    expect(isExcludedFromGate('/favicon.ico')).toBe(true);
    expect(isExcludedFromGate('/favicon.svg')).toBe(true);
  });

  it('does NOT exclude /theme.css — it stays gated behind auth', () => {
    expect(isExcludedFromGate('/theme.css')).toBe(false);
  });

  it('does not exclude ordinary routes', () => {
    expect(isExcludedFromGate('/')).toBe(false);
    expect(isExcludedFromGate('/api/whoami')).toBe(false);
    expect(isExcludedFromGate('/admin/quota')).toBe(false);
  });
});
