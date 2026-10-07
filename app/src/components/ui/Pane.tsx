/**
 * Pane/card primitive (wiki/Theming.md): a rounded card with the section
 * name in a title-bar strip. Hand-written, no component library (`FR-UI-4`)
 * — styling comes entirely from the `.sq-pane`/`.sq-titlebar`/`.sq-pane-title`
 * classes in `src/app/globals.css`, which in turn read only `--sq-*` custom
 * properties. The title bar is shown by default (`--sq-titlebar-display:
 * block`), styled as a plain, "no chrome" heading (small, semibold, muted
 * text — no border or background), matching the Seerr-like default theme.
 *
 * Deliberately `sq-pane-title`, NOT the generic `.sq-heading` class: that
 * class exists for section headings elsewhere in the app and carries an
 * optional `::before` decorative prefix (`--sq-heading-prefix`, e.g. a
 * terminal-style `$ `) that a theme override may turn on for *those*
 * headings. A pane title bar is a structurally different element and must
 * not pick that prefix up as a side effect of sharing a class name.
 */
import type { ReactNode } from 'react';

export interface PaneProps {
  /** Shown in the title bar strip, e.g. "my usage". Rendered verbatim — callers decide casing. */
  title: string;
  children: ReactNode;
  className?: string;
}

export function Pane({ title, children, className }: PaneProps) {
  return (
    <section className={`sq-pane ${className ?? ''}`.trim()}>
      <div className="sq-titlebar sq-pane-title">{title}</div>
      <div className="sq-pane-body">{children}</div>
    </section>
  );
}
