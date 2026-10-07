/**
 * Textarea primitive, matching `./Input.tsx`'s treatment — a plain bordered
 * field by default, with the same CSS-only decorative prompt/caret opt-ins.
 * The one multi-line field this app needs (the `FR-ADM-7` protect-title
 * reason, shown verbatim to the member it blocks). Hand-written, no
 * component library (`FR-UI-4`).
 *
 * The themable base look (background/border/radius/padding/colour) is
 * `.sq-input` (shared with `./Input.tsx`) plus the sizing-only additions in
 * `.sq-textarea`, both in `src/app/globals.css` — not inline here, so a
 * `THEME_CSS` override can actually redefine them. `style` is still accepted
 * and passed through for a one-off per-instance override.
 */
import type { TextareaHTMLAttributes } from 'react';

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export function Textarea({ style, className, ...rest }: TextareaProps) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'flex-start', gap: '0.375rem', width: '100%' }}>
      <span
        className="sq-input-prompt"
        aria-hidden
        style={{ color: 'var(--sq-dim)', marginTop: '0.125rem' }}
      />
      <textarea {...rest} className={`sq-input sq-textarea ${className ?? ''}`.trim()} style={style} />
    </span>
  );
}
