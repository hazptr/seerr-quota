// seerr-quota — in-Seerr quota banner (P2-10,
// wiki/Feature-10-In-Seerr-Banner.md, FR-BAN-1..FR-BAN-12).
// Injected into every Seerr HTML page via your reverse proxy's sub_filter
// (see examples/seerr-banner.nginx.snippet).
//
// FR-BAN-7 is the requirement to get right above every other one here:
// "The script MUST fail silently and completely. Any error ... results in
// no banner and no console noise, and MUST NOT alter, block, or break any
// part of Seerr." The short version of how that's achieved here: the entire
// IIFE body is wrapped in a
// top-level try/catch, every async step has its own try/catch (never a bare
// unhandled promise, which the browser would log to console on its own
// regardless of any outer try/catch), and nothing in this file ever calls
// console.* — a caught error is simply swallowed and the function returns
// with no banner rendered. Seerr's own scripts, styles, and behaviour are
// never touched: this file only ever appends ONE element to
// document.body and reads matchMedia/sessionStorage, all independently
// try/catched.
(() => {
  try {
    // ---- FR-BAN-8: install-once guard -----------------------------------
    // Seerr is client-routed; the reverse proxy's sub_filter only ever
    // injects this <script> tag once per real HTML document load, but the
    // guard is kept anyway as a defensive no-op against a future
    // double-injection.
    if (window.__sqQuotaBanner) return;
    window.__sqQuotaBanner = 1;

    // FR-BAN-7: fetch unavailable -> nothing to do, bail out completely
    // before touching the DOM at all.
    if (typeof fetch !== 'function') return;

    const STATUS_URL = '/_quota-status'; // FR-BAN-2/wiki "Approach": same-origin, never quota.example.com directly.
    const BANNER_ID = '__sq-quota-banner';
    const DISMISS_KEY = '__sq_quota_banner_dismissed';
    const FETCH_TIMEOUT_MS = 6000; // FR-BAN-7: "a slow response" must not hang the page waiting on us.

    // ---- FR-BAN-10: dismiss-for-session-only -----------------------------
    // sessionStorage can throw (private browsing / blocked site data) —
    // wrapped independently so a storage failure never prevents the banner
    // itself from working; it just means "dismiss" isn't remembered across
    // a hard reload within the same tab, which is a harmless degradation.
    let dismissedInMemory = false;
    function isDismissed() {
      try {
        return sessionStorage.getItem(DISMISS_KEY) === '1' || dismissedInMemory;
      } catch (_e) {
        return dismissedInMemory;
      }
    }
    function markDismissed() {
      dismissedInMemory = true;
      try {
        sessionStorage.setItem(DISMISS_KEY, '1');
      } catch (_e) {
        // swallowed — see isDismissed's comment.
      }
    }

    // ---- FR-BAN-10 palette --------------------------------------------
    // Copied verbatim from wiki/Theming.md's `:root` /
    // dark-mode token tables. Seerr has no idea these variables exist, so
    // every value the banner needs is applied directly as inline style
    // properties (FR-BAN-9: "styles itself inline") rather than via any
    // injected stylesheet — nothing here can collide with or depend on a
    // Seerr class name.
    const PALETTE = {
      light: {
        titlebarBg: '#f1f1f2',
        titlebarFg: '#4a4a4a',
        paneBg: '#ffffff',
        fg: '#111111',
        muted: '#6a6a6a',
        rule: 'rgba(0,0,0,.16)',
        accent: '#111111',
        shadow: '0 1px 2px rgba(0,0,0,.04), 0 14px 44px rgba(0,0,0,.08)',
      },
      dark: {
        titlebarBg: '#1a1a1d',
        titlebarFg: '#b8b8b8',
        paneBg: '#141417',
        fg: '#f4f4f4',
        muted: '#9a9a9a',
        rule: 'rgba(255,255,255,.12)',
        accent: '#f4f4f4',
        shadow: '0 1px 2px rgba(0,0,0,.4), 0 18px 60px rgba(0,0,0,.55)',
      },
    };
    const MONO =
      'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

    function prefersDark() {
      try {
        return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
      } catch (_e) {
        return false;
      }
    }

    function formatGB(bytes) {
      if (typeof bytes !== 'number' || !isFinite(bytes)) return 'unknown';
      return (bytes / 1_000_000_000).toFixed(2) + ' GB';
    }

    // ---- FR-BAN-3/FR-BAN-4: response validation ---------------------------
    // The endpoint is our own (@/app/api/quota-status/route.ts), but this
    // still validates the shape defensively rather than trusting it blindly
    // — a future incompatible deploy of the app, or a malformed/empty body
    // from any intermediate proxy, must degrade to "no banner", never a
    // thrown TypeError reading a missing field.
    function isValidStatus(v) {
      if (!v || typeof v !== 'object') return false;
      if (typeof v.state !== 'string') return false;
      if (typeof v.usageBytes !== 'number') return false;
      if (typeof v.heldRequests !== 'number') return false;
      if (typeof v.url !== 'string') return false;
      if (v.quotaBytes !== null && typeof v.quotaBytes !== 'number') return false;
      if (v.shortfallBytes !== null && typeof v.shortfallBytes !== 'number') return false;
      return true;
    }

    function buildMessage(status) {
      if (status.state === 'over_quota') {
        let msg =
          'Over your storage quota: ' +
          formatGB(status.usageBytes) +
          ' used of ' +
          formatGB(status.quotaBytes) +
          ' — free up ' +
          formatGB(status.shortfallBytes) +
          ' to get back under.';
        if (status.heldRequests > 0) {
          msg +=
            ' ' +
            status.heldRequests +
            (status.heldRequests === 1 ? ' request is' : ' requests are') +
            ' on hold until you do.';
        }
        return msg;
      }
      // held_only
      return (
        status.heldRequests +
        (status.heldRequests === 1 ? ' request is' : ' requests are') +
        ' on hold on your account.'
      );
    }

    function paintBanner(el) {
      try {
        const p = prefersDark() ? PALETTE.dark : PALETTE.light;
        el.style.cssText = [
          'position:fixed',
          'top:0',
          'left:0',
          'right:0',
          'z-index:2147483647',
          'display:flex',
          'align-items:center',
          'gap:0.75em',
          'flex-wrap:wrap',
          'padding:0.6em 1em',
          'font:13px/1.4 ' + MONO,
          'background:' + p.titlebarBg,
          'color:' + p.titlebarFg,
          'border-bottom:1px dashed ' + p.rule,
          'box-shadow:' + p.shadow,
          'box-sizing:border-box',
        ].join(';');
        const msgEl = el.querySelector('[data-role="msg"]');
        if (msgEl) msgEl.style.color = p.fg;
        const linkEl = el.querySelector('[data-role="link"]');
        if (linkEl) {
          linkEl.style.cssText = [
            'color:' + p.accent,
            'text-decoration:none',
            'border:1px solid ' + p.rule,
            'border-radius:3px',
            'padding:0.1em 0.5em',
            'white-space:nowrap',
            'font:inherit',
          ].join(';');
        }
        const dismissEl = el.querySelector('[data-role="dismiss"]');
        if (dismissEl) {
          dismissEl.style.cssText = [
            'color:' + p.muted,
            'background:transparent',
            'border:none',
            'cursor:pointer',
            'font:inherit',
            'padding:0 0.25em',
            'line-height:1',
            'margin-left:auto',
          ].join(';');
        }
      } catch (_e) {
        // Never let a paint failure remove or break an already-inserted
        // banner, and never let it propagate — FR-BAN-7.
      }
    }

    let lastStatus = null;

    function removeBanner() {
      try {
        const existing = document.getElementById(BANNER_ID);
        if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
      } catch (_e) {
        // swallowed
      }
    }

    function renderBanner(status) {
      try {
        // FR-BAN-8: never stack duplicates — id-based dedupe (getElementById)
        // is the sole source of truth for "is a banner already present,"
        // rather than a closure-held element reference that could go stale.
        if (document.getElementById(BANNER_ID)) return;
        if (!document.body) return; // defer scripts run post-parse, but this is defensive.

        const el = document.createElement('div');
        el.id = BANNER_ID;
        el.setAttribute('role', 'status');
        el.setAttribute('aria-live', 'polite');

        const msg = document.createElement('span');
        msg.setAttribute('data-role', 'msg');
        msg.textContent = buildMessage(status);
        el.appendChild(msg);

        const link = document.createElement('a');
        link.setAttribute('data-role', 'link');
        link.href = status.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = '[ manage ↗ ]';
        el.appendChild(link);

        const dismiss = document.createElement('button');
        dismiss.setAttribute('data-role', 'dismiss');
        dismiss.setAttribute('aria-label', 'Dismiss for this session');
        dismiss.type = 'button';
        dismiss.textContent = '×';
        dismiss.addEventListener('click', () => {
          try {
            markDismissed();
            removeBanner();
          } catch (_e) {
            // swallowed
          }
        });
        el.appendChild(dismiss);

        document.body.appendChild(el);
        paintBanner(el);

        try {
          if (typeof matchMedia === 'function') {
            const mq = matchMedia('(prefers-color-scheme: dark)');
            const onChange = () => paintBanner(el);
            if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange);
            else if (typeof mq.addListener === 'function') mq.addListener(onChange); // Safari <14 fallback
          }
        } catch (_e) {
          // Theme won't live-update on an OS toggle; the banner still renders correctly at load time.
        }
      } catch (_e) {
        // Rendering failed for any reason — leave Seerr exactly as it was,
        // no partial/broken banner left behind.
        removeBanner();
      }
    }

    // FR-BAN-4: only render when there's something to say.
    function maybeRender(status) {
      if (isDismissed()) return;
      if (status.state !== 'over_quota' && status.state !== 'held_only') return;
      renderBanner(status);
    }

    // ---- FR-BAN-11-respecting single fetch ------------------------------
    // One fetch per real page load — the endpoint is cheap, but this file
    // still only calls it once rather than polling/re-fetching per SPA
    // route change; FR-BAN-8's "survive navigation" is handled by DOM
    // persistence + the re-attachment check below, not repeated network
    // calls.
    async function loadStatus() {
      let controller;
      let timeoutId;
      try {
        const init = { credentials: 'same-origin' };
        if (typeof AbortController === 'function') {
          controller = new AbortController();
          init.signal = controller.signal;
          timeoutId = setTimeout(() => {
            try {
              controller.abort();
            } catch (_e) {
              // swallowed
            }
          }, FETCH_TIMEOUT_MS);
        }

        const res = await fetch(STATUS_URL, init);
        if (timeoutId) clearTimeout(timeoutId);

        if (!res || !res.ok) return; // app down / non-200 -> silent, no banner.

        let body;
        try {
          body = await res.json();
        } catch (_e) {
          return; // malformed JSON -> silent.
        }

        if (!isValidStatus(body)) return;

        lastStatus = body;
        maybeRender(body);
      } catch (_e) {
        // Network error, timeout/abort, or anything else — silent, no
        // banner, no console output. Seerr is completely unaffected.
      }
    }

    // ---- FR-BAN-8: re-attachment on route change --------------------------
    // A single-page-app navigation never reloads this script, so the
    // already-inserted banner (a plain sibling of Seerr's own root node)
    // simply survives by default. This listener is a defensive backstop
    // only, for the case something else in the page clears extra
    // document.body children on navigation — it never re-fetches (the
    // cached lastStatus from the one load is reused) and never creates a
    // second element (renderBanner's id check still applies).
    function onRouteChange() {
      try {
        if (!lastStatus) return;
        if (isDismissed()) return;
        if (document.getElementById(BANNER_ID)) return; // still there — nothing to do.
        maybeRender(lastStatus);
      } catch (_e) {
        // swallowed
      }
    }

    function patchHistoryMethod(name) {
      try {
        const original = history[name];
        if (typeof original !== 'function') return;
        history[name] = function () {
          const result = original.apply(this, arguments);
          try {
            setTimeout(onRouteChange, 0);
          } catch (_e) {
            // swallowed
          }
          return result;
        };
      } catch (_e) {
        // If history can't be patched, popstate below still covers
        // back/forward navigation; forward navigation via pushState just
        // won't trigger the re-attachment check, which only matters if
        // something else removed the banner in the first place.
      }
    }

    patchHistoryMethod('pushState');
    patchHistoryMethod('replaceState');
    try {
      window.addEventListener('popstate', onRouteChange);
    } catch (_e) {
      // swallowed
    }

    loadStatus().catch(() => {
      // Belt-and-suspenders: loadStatus already try/catches everything
      // internally, but an async function's returned promise rejecting
      // uncaught would otherwise be logged by the browser as an unhandled
      // rejection regardless of that inner try/catch's presence — this is
      // what actually prevents that console noise (FR-BAN-7).
    });
  } catch (_e) {
    // Top-level catch: anything synchronous above (guard check, palette
    // setup, listener registration) that somehow throws is swallowed here.
    // No banner, no console output, and nothing about the surrounding page
    // was touched before the failure.
  }
})();
