import { NextResponse } from 'next/server';
import { APP_VERSION } from '@/lib/version';

// Unauthenticated liveness probe for an uptime monitor (e.g. Gatus,
// wiki/Deployment.md §5) and the Docker/operator smoke check. Per
// Feature-01 FR-SSO-6, this route MUST stay outside any auth gate and MUST
// NOT resolve identity or call any upstream — it only proves the Node
// process is up. `/healthz?deep=1` (snapshot-age reporting) is a later item
// (P3-1) and deliberately not implemented here.
//
// `version` (item 2, "Versioning") reads `src/lib/version.ts`, itself a
// plain `package.json` import — no identity module, no upstream call, so it
// doesn't violate the constraint above.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json({ status: 'ok', service: 'seerr-quota', version: APP_VERSION }, { status: 200 });
}
