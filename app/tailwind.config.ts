import type { Config } from 'tailwindcss';

/**
 * No color palette extension here, deliberately: the `--sq-*` tokens in
 * `src/app/globals.css` (wiki/Theming.md) are plain hex/rgba literals, not
 * the `R G B` space-separated triples Tailwind's `rgb(var(--x) /
 * <alpha-value>)` opacity trick requires. Consumers reach the tokens
 * directly via `var(--sq-*)` — in `globals.css`'s primitive classes, or
 * inline/arbitrary-value Tailwind (`bg-[var(--sq-pane-bg)]`) — never a
 * `bg-sq-pane` utility. Tailwind is still used for layout/spacing utilities;
 * only color is kept out of its theme config, so a runtime `THEME_CSS`
 * override (see `src/lib/theme/config.ts`) can redefine any token without
 * needing a rebuild.
 */
const config: Config = {
  darkMode: ['selector', '[data-theme="dark"]'],
  content: ['./src/app/**/*.{ts,tsx}', './src/components/**/*.{ts,tsx}'],
  theme: {
    extend: {},
  },
  plugins: [],
};

export default config;
