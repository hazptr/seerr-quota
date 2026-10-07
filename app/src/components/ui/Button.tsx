/**
 * Button primitive (wiki/Theming.md "Token reference"): a plain rounded,
 * filled button by default (indigo accent / critical red for destructive),
 * with an optional bracket-style decoration (`[ label ]`) that a theme
 * override can turn on purely in CSS via `--sq-btn-decoration-prefix` /
 * `-suffix` (empty strings in the default theme — see `globals.css`'s
 * `.sq-btn-decoration-prefix`/`-suffix` rules) — no markup or component
 * change needed to switch between the two looks. Hand-written, no component
 * library (`FR-UI-4`).
 */
import type { ButtonHTMLAttributes } from 'react';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'destructive' | 'plain';
}

export function Button({ variant = 'primary', children, className, ...rest }: ButtonProps) {
  const variantClass = variant === 'destructive' ? 'sq-btn-destructive' : variant === 'plain' ? 'sq-btn-plain' : '';
  return (
    <button {...rest} className={`sq-btn ${variantClass} ${className ?? ''}`.trim()}>
      <span className="sq-btn-decoration-prefix" aria-hidden />
      {children}
      <span className="sq-btn-decoration-suffix" aria-hidden />
    </button>
  );
}
