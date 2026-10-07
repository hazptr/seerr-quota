/**
 * App version readout (item 2, "Versioning"). The Dockerfile's `builder`
 * stage runs `npm pkg set version="$APP_VERSION"` before `next build`
 * (`ARG APP_VERSION`, default `0.0.0-dev`), and the `runner` stage copies
 * the resulting `package.json` forward — so `package.json`'s own `version`
 * field is the one value that is correct in every context: local dev
 * (`0.0.0-dev`, untouched), a CI `edge`/`sha` build (`git describe`), and a
 * tagged release (`X.Y.Z`). Read it directly here rather than threading a
 * separate env var through, so there is exactly one source of truth and it
 * can never drift from what actually got built.
 *
 * The footer (`src/app/layout.tsx`'s `RootLayout`, a server component) and
 * `/healthz` both import `APP_VERSION` from this module directly rather than
 * threading the value through a separate `NEXT_PUBLIC_*` env var — neither
 * needs a client-side value, so there's exactly one source of truth.
 */
import pkg from '../../package.json';

export const APP_VERSION: string = pkg.version;
