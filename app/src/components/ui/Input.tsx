/**
 * Input primitive (wiki/Theming.md): a plain bordered input by default. The
 * decorative prompt glyph (`❯`) and block caret from the terminal theme are
 * CSS-only opt-ins (`--sq-input-prompt`, `--sq-input-caret`) — empty/auto in
 * the default theme, so this component never needs to change to switch
 * looks. Hand-written, no component library (`FR-UI-4`).
 *
 * The themable base look (background/border/radius/padding/colour) lives in
 * `.sq-input` in `src/app/globals.css`, not inline here — a `THEME_CSS`
 * override can only redefine a `--sq-*` token or a `.sq-*` class, so an
 * inline `style={{...}}` baked into the component would be invisible to it.
 * `style` is still accepted and passed through for a one-off per-instance
 * override.
 */
import type { InputHTMLAttributes } from 'react';

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export function Input({ style, className, ...rest }: InputProps) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.375rem' }}>
      <span className="sq-input-prompt" aria-hidden style={{ color: 'var(--sq-dim)' }} />
      <input {...rest} className={`sq-input ${className ?? ''}`.trim()} style={style} />
    </span>
  );
}
