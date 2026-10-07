/**
 * Shared prev/next pager for the paginated sections of the member drill-down
 * (`FR-ADM-5`). Plain `<a>` links carrying the full query string — no client
 * JS required (`FR-UI-9`'s spirit, applied to an admin-only read screen too),
 * and works identically whether the page is reached directly or via a link.
 */
import Link from 'next/link';
import type { PageMeta } from './logic';

export function Pagination({
  basePath,
  paramName,
  meta,
  otherParams = {},
}: {
  basePath: string;
  paramName: string;
  meta: PageMeta;
  /** Other query params to preserve (e.g. the other two sections' own page numbers) so paging one list doesn't reset the others. */
  otherParams?: Record<string, string | number>;
}) {
  if (meta.pageCount <= 1) return null;

  function hrefForPage(page: number): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(otherParams)) params.set(key, String(value));
    params.set(paramName, String(page));
    return `${basePath}?${params.toString()}`;
  }

  return (
    <nav aria-label="pagination" style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', fontSize: '0.8125rem', marginTop: '0.5rem' }}>
      {meta.page > 1 ? (
        <Link href={hrefForPage(meta.page - 1)}>&larr; prev</Link>
      ) : (
        <span style={{ color: 'var(--sq-dim)' }}>&larr; prev</span>
      )}
      <span style={{ color: 'var(--sq-muted)' }}>
        page {meta.page} / {meta.pageCount} ({meta.totalCount} total)
      </span>
      {meta.page < meta.pageCount ? (
        <Link href={hrefForPage(meta.page + 1)}>next &rarr;</Link>
      ) : (
        <span style={{ color: 'var(--sq-dim)' }}>next &rarr;</span>
      )}
    </nav>
  );
}
