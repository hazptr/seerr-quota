/**
 * Serves the operator's runtime theme override (wiki/Theming.md "Env
 * vars") from `THEME_CSS`, read fresh from disk on every request — this is
 * the whole point: images are prebuilt, so a theme change is a file edit +
 * (at most) a container restart, never a rebuild.
 *
 * The path comes ONLY from `getThemeConfig()` (env), never from this
 * request — there is no query param, header, or cookie that influences
 * which file gets read, so this route cannot be used to read an arbitrary
 * file the deployer didn't already point it at via `THEME_CSS`.
 *
 * `THEME_CSS` unset, or the file missing/unreadable, both degrade to a 404
 * with an empty body — never a 500 — so a deployment that doesn't use this
 * feature never sees an error, and `layout.tsx`'s `<link>` to this route is
 * harmless either way.
 */
import { NextResponse, type NextRequest } from 'next/server';
import fs from 'node:fs';
import { getThemeConfig } from '@/lib/theme/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function empty404(): NextResponse {
  return new NextResponse(null, { status: 404 });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { themeCssPath } = getThemeConfig();
  if (!themeCssPath) {
    return empty404();
  }

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(themeCssPath);
  } catch {
    return empty404();
  }
  if (!stat.isFile()) {
    return empty404();
  }

  // mtime-based revalidation: a client that sends back the `Last-Modified`
  // value this route handed out earlier (as `If-Modified-Since`) gets a bare
  // 304 when the file hasn't changed since, sparing the disk read + body on
  // every poll. `Date` headers are second-resolution, so compare at that
  // granularity rather than failing a false negative on sub-second drift.
  const lastModified = stat.mtime;
  const ifModifiedSince = req.headers.get('if-modified-since');
  if (ifModifiedSince) {
    const since = new Date(ifModifiedSince);
    if (!Number.isNaN(since.getTime()) && Math.floor(lastModified.getTime() / 1000) <= Math.floor(since.getTime() / 1000)) {
      return new NextResponse(null, {
        status: 304,
        headers: {
          'Cache-Control': 'private, max-age=60',
          'Last-Modified': lastModified.toUTCString(),
        },
      });
    }
  }

  let css: string;
  try {
    css = await fs.promises.readFile(themeCssPath, 'utf-8');
  } catch {
    return empty404();
  }

  return new NextResponse(css, {
    status: 200,
    headers: {
      'Content-Type': 'text/css; charset=utf-8',
      // Short cache — long enough to spare a disk read on every asset
      // request, short enough that an operator's edit shows up without
      // waiting out a long TTL. Revalidated against the file's mtime above
      // (If-Modified-Since -> 304) rather than relying on max-age alone.
      'Cache-Control': 'private, max-age=60',
      'Last-Modified': lastModified.toUTCString(),
    },
  });
}
