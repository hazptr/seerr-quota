// seerr-quota — in-Seerr ANNOUNCEMENT banner.
//
// Distinct from quota-banner.js (P2-10, wiki/Feature-10-In-Seerr-Banner.md),
// which is the *over-quota* banner driven by /_quota-status and is not
// deployed. This one is a one-off, time-boxed announcement: it tells members
// the quota dashboard exists and that enforcement begins on a stated date.
// It is deliberately STATIC — no fetch, no status endpoint, no dependency on
// seerr-quota being reachable at all. The real numbers live one click away on
// quota.example.com; duplicating them here would add a network failure path to
// a banner whose entire job is to be seen.
//
// Two behaviours worth stating up front, both about *when* it appears:
//
//   1. It does NOT render on Seerr's own /login page. The announcement is for
//      members who are in the app; showing it over the login form is noise at
//      the moment somebody is trying to do something else, and it would be
//      dismissed unread. The script waits, and renders once they are past it.
//   1a. Dismissing SNOOZES it rather than hiding it forever — weekly while the
//      deadline is far off, daily in the last three days. An announcement with
//      a date that can be permanently dismissed on day one is not really an
//      announcement.
//   2. It slides in shortly after arrival rather than being present in the
//      first paint. A banner that is simply *there* reads as page furniture
//      and gets ignored; one that arrives is noticed. `prefers-reduced-motion`
//      turns the movement off (the delay stays — it is not the animation that
//      does the work, it is the change).
//
// Route changes are detected by POLLING location.pathname, deliberately.
// Seerr is a client-routed SPA, and the obvious alternative — patching
// history.pushState — would mean modifying a global belonging to another
// application, which is exactly what FR-BAN-7 forbids. A 1s interval that
// stops itself is cheap and cannot affect Seerr's behaviour.
//
// The rule that outranks everything else here is quota-banner.js's FR-BAN-7:
// the script MUST fail silently and completely, and MUST NOT alter, block, or
// break any part of Seerr. Same construction as its sibling: the whole body is
// one try/catch, every storage/matchMedia access is independently try/catched,
// nothing ever calls console.*, and the only DOM mutation is appending exactly
// one element to document.body.
(() => {
  try {
    if (window.__sqQuotaAnnounce) return;
    window.__sqQuotaAnnounce = 1;

    const BANNER_ID = '__sq-quota-announce';
    // Bump this suffix to re-show the banner to everyone who dismissed the
    // previous one — a dismissal is per-announcement, not forever.
    const DISMISS_KEY = '__sq_quota_announce_dismissed_v1';

    // Enforcement start. After this instant the announcement is pointless, so
    // it stops rendering on its own rather than becoming a stale fixture
    // nobody can remove without another nginx change.
    //
    // OPERATOR: edit ENFORCE_AT, ENFORCE_LABEL, and QUOTA_URL below before
    // deploying this snippet — these are placeholders, not real values.
    const ENFORCE_AT = new Date('2030-01-01T00:00:00Z');
    const ENFORCE_LABEL = '1 January';
    const QUOTA_LABEL = 'N GB'; // OPERATOR: the per-member quota, e.g. "500 GB" or "1 TB"
    const QUOTA_URL = 'https://quota.example.com/';
    const ENTRANCE_DELAY_MS = 900;   // after landing, so it reads as an arrival
    const ROUTE_POLL_MS = 1000;
    const ROUTE_POLL_MAX_MS = 300000; // give up watching after 5 min; never poll forever

    if (!(ENFORCE_AT instanceof Date) || isNaN(ENFORCE_AT.getTime())) return;
    if (Date.now() >= ENFORCE_AT.getTime()) return;

    // Dismissal is a SNOOZE, not a permanent hide.
    //
    // The first version stored a boolean and hid the banner forever. That is
    // wrong for an announcement with a deadline: dismiss it on day one and you
    // would never see it again before enforcement starts, which defeats the
    // entire point of announcing it six weeks ahead. So the dismissal stores a
    // timestamp, and the banner returns after a cooldown that SHRINKS as the
    // date approaches — a nudge a month out, a daily reminder in the last few
    // days.
    //
    // Migration is free: the old value was the string '1', which parses as
    // 1ms-after-epoch and is therefore older than any cooldown, so anyone who
    // dismissed the previous version simply sees it once more. No key bump and
    // no manual clearing needed.
    const DAY_MS = 86400000;
    const COOLDOWNS = [
      { withinDaysOfDeadline: 3, cooldownDays: 1 },   // final stretch: daily
      { withinDaysOfDeadline: 14, cooldownDays: 3 },  // fortnight out: every few days
    ];
    const DEFAULT_COOLDOWN_DAYS = 7;                  // further out: weekly at most

    function cooldownMs() {
      try {
        const daysLeft = (ENFORCE_AT.getTime() - Date.now()) / DAY_MS;
        for (const tier of COOLDOWNS) {
          if (daysLeft <= tier.withinDaysOfDeadline) return tier.cooldownDays * DAY_MS;
        }
      } catch (_e) {
        // fall through to the default
      }
      return DEFAULT_COOLDOWN_DAYS * DAY_MS;
    }

    let dismissedInMemory = false;
    function isDismissed() {
      if (dismissedInMemory) return true;
      try {
        const raw = localStorage.getItem(DISMISS_KEY);
        if (raw === null) return false;
        const at = Number(raw);
        // Unparseable/absurd value -> treat as not dismissed. Showing the
        // banner one extra time is a far cheaper failure than silently
        // suppressing a deadline notice.
        if (!isFinite(at) || at <= 0) return false;
        return Date.now() - at < cooldownMs();
      } catch (_e) {
        return false;
      }
    }
    function setDismissed() {
      dismissedInMemory = true;
      try {
        localStorage.setItem(DISMISS_KEY, String(Date.now()));
      } catch (_e) {
        // Private browsing / blocked site data — the in-memory flag still
        // hides it for this page view, which is the best available.
      }
    }

    if (isDismissed()) return;

    // Palette copied verbatim from quota-banner.js, which copied it from
    // wiki/Theming.md's token tables. Applied inline so
    // nothing can collide with a Seerr class name.
    const PALETTE = {
      light: { bg: '#f1f1f2', titlebarFg: '#4a4a4a', fg: '#111111', muted: '#6a6a6a', rule: 'rgba(0,0,0,.16)', accent: '#111111', shadow: '0 1px 2px rgba(0,0,0,.04), 0 14px 44px rgba(0,0,0,.08)' },
      dark: { bg: '#1a1a1d', titlebarFg: '#b8b8b8', fg: '#f4f4f4', muted: '#9a9a9a', rule: 'rgba(255,255,255,.12)', accent: '#f4f4f4', shadow: '0 1px 2px rgba(0,0,0,.4), 0 18px 60px rgba(0,0,0,.55)' },
    };
    const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

    function prefersReducedMotion() {
      try {
        return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
      } catch (_e) {
        return false;
      }
    }

    /** Seerr's own auth screens. The banner has nothing to say to someone who isn't in yet. */
    function onLoginPage() {
      try {
        return /^\/(login|setup|resetpassword)/.test(location.pathname || '');
      } catch (_e) {
        return false;
      }
    }

    function palette() {
      try {
        return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? PALETTE.dark : PALETTE.light;
      } catch (_e) {
        return PALETTE.light;
      }
    }

    function render() {
      try {
        if (!document.body || document.getElementById(BANNER_ID)) return;
        const p = palette();

        const el = document.createElement('div');
        el.id = BANNER_ID;
        el.setAttribute('role', 'status');
        const reduced = prefersReducedMotion();
        el.style.cssText = [
          'position:fixed', 'top:0', 'left:0', 'right:0',
          'z-index:2147483647',
          'display:flex', 'align-items:center', 'gap:0.75em', 'flex-wrap:wrap',
          'padding:0.6em 1em',
          'font:13px/1.4 ' + MONO,
          'background:' + p.bg,
          'color:' + p.titlebarFg,
          'border-bottom:1px dashed ' + p.rule,
          'box-shadow:' + p.shadow,
          'box-sizing:border-box',
          // Start off-screen and transparent; the rAF below drops it in.
          // Inline transition rather than an injected @keyframes, so this file
          // still adds no stylesheet to Seerr.
          reduced ? 'transform:none' : 'transform:translateY(-110%)',
          reduced ? 'opacity:1' : 'opacity:0',
          reduced ? '' : 'transition:transform 420ms cubic-bezier(.2,.8,.2,1), opacity 300ms ease-out',
          'will-change:transform',
        ].filter(Boolean).join(';');

        // textContent throughout — never innerHTML. Nothing here is
        // user-supplied today, but a banner injected into every page of
        // another app is the wrong place to establish an HTML-parsing habit.
        const dot = document.createElement('span');
        dot.textContent = '●';
        dot.style.cssText = 'color:' + p.accent + ';flex:none';

        const msg = document.createElement('span');
        msg.style.cssText = 'color:' + p.fg + ';flex:1 1 20em;min-width:0';
        msg.textContent =
          'New: you now have a storage dashboard showing how much disk your requests use. ' +
          'Everyone gets ' + QUOTA_LABEL + ', and from ' + ENFORCE_LABEL + ' requests over that limit will be held until you free up space.';

        const link = document.createElement('a');
        link.setAttribute('data-role', 'link');
        link.href = QUOTA_URL;
        link.textContent = 'see my usage';
        link.style.cssText = ['color:' + p.accent, 'text-decoration:none', 'border:1px solid ' + p.rule, 'border-radius:3px', 'padding:0.1em 0.5em', 'white-space:nowrap', 'font:inherit', 'flex:none'].join(';');

        const dismiss = document.createElement('button');
        dismiss.type = 'button';
        dismiss.setAttribute('aria-label', 'Dismiss this announcement (it will return closer to the deadline)');
        dismiss.title = 'Dismiss — this will come back closer to ' + ENFORCE_LABEL;
        dismiss.textContent = '✕';
        dismiss.style.cssText = ['color:' + p.muted, 'background:transparent', 'border:none', 'cursor:pointer', 'font:inherit', 'padding:0 0.25em', 'line-height:1', 'flex:none'].join(';');
        dismiss.addEventListener('click', () => {
          try {
            setDismissed();
            const drop = () => {
              try {
                if (el.parentNode) el.parentNode.removeChild(el);
              } catch (_e) {
                /* swallowed */
              }
            };
            if (prefersReducedMotion()) {
              drop();
            } else {
              // Slide back out, then remove. The timeout is the fallback for
              // the case where transitionend never fires (element hidden, tab
              // backgrounded) — the row must not be left stuck on screen.
              el.style.transform = 'translateY(-110%)';
              el.style.opacity = '0';
              el.addEventListener('transitionend', drop, { once: true });
              setTimeout(drop, 600);
            }
          } catch (_e) {
            // swallowed — FR-BAN-7
          }
        });

        el.appendChild(dot);
        el.appendChild(msg);
        el.appendChild(link);
        el.appendChild(dismiss);
        document.body.appendChild(el);

        // Two nested rAFs: the first lets the browser commit the off-screen
        // start state, the second changes it — without this the transition is
        // skipped entirely because both states land in the same frame.
        if (!reduced) {
          try {
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                try {
                  el.style.transform = 'translateY(0)';
                  el.style.opacity = '1';
                } catch (_e) {
                  /* swallowed */
                }
              });
            });
          } catch (_e) {
            // No rAF — leave it where it is and make it visible immediately
            // rather than stranding it off-screen.
            el.style.transform = 'none';
            el.style.opacity = '1';
          }
        }
      } catch (_e) {
        // A paint failure must never propagate into Seerr's own scripts.
      }
    }

    // ---- scheduling: after login, and a beat after arrival ---------------
    let fired = false;
    function fireOnce() {
      if (fired) return;
      fired = true;
      try {
        setTimeout(render, ENTRANCE_DELAY_MS);
      } catch (_e) {
        render();
      }
    }

    /**
     * If we're already past the login screen, schedule immediately. Otherwise
     * poll for the route change that means they just signed in, and schedule
     * then — so the banner arrives *into* the app rather than sitting on the
     * login form. Gives up after ROUTE_POLL_MAX_MS so a tab parked on /login
     * never holds an interval open indefinitely.
     */
    function scheduleWhenSignedIn() {
      try {
        if (!onLoginPage()) {
          fireOnce();
          return;
        }
        const startedAt = Date.now();
        const timer = setInterval(() => {
          try {
            if (!onLoginPage()) {
              clearInterval(timer);
              fireOnce();
              return;
            }
            if (Date.now() - startedAt > ROUTE_POLL_MAX_MS) clearInterval(timer);
          } catch (_e) {
            try {
              clearInterval(timer);
            } catch (_e2) {
              /* swallowed */
            }
          }
        }, ROUTE_POLL_MS);
      } catch (_e) {
        // Scheduling itself failed — fall back to rendering plainly rather
        // than silently never showing the announcement at all.
        render();
      }
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', scheduleWhenSignedIn, { once: true });
    } else {
      scheduleWhenSignedIn();
    }
  } catch (_e) {
    // Total, silent failure. Seerr is unaffected.
  }
})();
