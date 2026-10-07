/**
 * `nodemailer`-backed implementation of `MailTransport` for this app's SMTP
 * relay (`wiki/Configuration.md` §"Upstream endpoints") — any SMTP relay
 * reachable from the container, e.g. Proton Bridge, a local Postfix/MSA, or
 * a provider's SMTP, not a specific assumed transport. Replaces an earlier
 * ~360-line hand-rolled `node:net`/`node:tls` SMTP client: that client had
 * no RFC 2047 encoded-word support for non-ASCII `Subject`/body text — a
 * real gap, since the library already holds titles like `Les Misérables`
 * and `Naked Gun 33⅓` — and no test ever drove it against a real or fake
 * SMTP server. `nodemailer` has **zero runtime dependencies** (verify with
 * `npm ls nodemailer` — no nested `dependencies` in its `package.json`), so
 * this swap doesn't trade one maintenance burden for a bigger one; it trades
 * hand-written protocol code with no test coverage for a widely-used
 * library's protocol code with none of ours to maintain.
 *
 * `buildMailOptions` below is deliberately pure (AGENTS.md rule 9: "pure
 * core, impure shell") and exported specifically so `test/mail-transport.test.ts`
 * can drive it through `nodemailer`'s own `streamTransport` (buffered) to
 * prove non-ASCII subjects/bodies actually get RFC 2047 / quoted-printable
 * encoded rather than written as raw bytes — the defect the old code had.
 * `createSmtpTransport` itself (the impure shell) is not directly unit
 * tested — no test in this repo opens a real SMTP connection or sends real
 * mail; it is exercised end-to-end via the fake `MailTransport` injected in
 * `test/enforcement-notify-real.test.ts`, same as before.
 */
import nodemailer, { type Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface MailTransport {
  /** Throws on ANY failure — refused connection, rejected AUTH, an upstream 4xx/5xx, a timeout (whatever error `nodemailer`'s SMTP transport rejects `sendMail` with). Never partially sends: either the server accepted the full DATA transaction, or this rejects. `@/lib/enforcement/notify.ts` is the only caller and treats every rejection identically ("not sent, audit it, never break enforcement over it"). */
  send(message: MailMessage): Promise<void>;
}

export interface SmtpTransportConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  fromName?: string;
  /** Per-message end-to-end timeout, applied to every one of nodemailer's three separate timeout knobs (`connectionTimeout`/`greetingTimeout`/`socketTimeout`) below — mirrors `UPSTREAM_TIMEOUT`'s role for this app's HTTP clients (`wiki/Configuration.md`). Default 20s. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Pure: builds the `nodemailer` `Mail.Options` for one message. No I/O — see
 * this file's header comment for why this is split out and exported.
 */
export function buildMailOptions(
  config: Pick<SmtpTransportConfig, 'from' | 'fromName'>,
  message: MailMessage,
): SMTPTransport.MailOptions {
  return {
    from: config.fromName ? { name: config.fromName, address: config.from } : config.from,
    to: message.to,
    subject: message.subject,
    text: message.text,
  };
}

/**
 * Builds a `MailTransport` wired to one SMTP relay config. Lazy in
 * the same sense the old socket client was: `nodemailer.createTransport`
 * itself opens no connection — `SMTPTransport` (the pooled=false default)
 * connects fresh per `sendMail` call, one connection per message, matching
 * this app's volume (single-digit members, at most one hold email per
 * member per `NOTIFY_COOLDOWN`) and avoiding any state about a
 * possibly-idle persistent connection surviving between 15-minute poller
 * cycles — same reasoning the old client's header comment gave.
 *
 * `secure: false` + `requireTLS: true` on port 25 is STARTTLS, not implicit
 * TLS: connect in plaintext, then require (and fail hard if unavailable)
 * an upgrade via the `STARTTLS` command — the same "refuse to send
 * credentials/mail in the clear" behaviour the old code enforced by hand
 * via its own `caps.has('STARTTLS')` check. `tls.rejectUnauthorized: true`
 * keeps certificate verification on (it's nodemailer's default too; set
 * explicitly here so it can't silently drift).
 */
export function createSmtpTransport(config: SmtpTransportConfig): MailTransport {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const transporter: Transporter<SMTPTransport.SentMessageInfo> = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: false,
    requireTLS: true,
    auth: { user: config.user, pass: config.pass },
    tls: { rejectUnauthorized: true },
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
  });

  return {
    async send(message: MailMessage): Promise<void> {
      await transporter.sendMail(buildMailOptions(config, message));
    },
  };
}
