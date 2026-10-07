/**
 * Public surface of the mail module (P2-9, `wiki/Feature-05-Enforcement.md`
 * `FR-ENF-13`). Callers elsewhere in the app — today just
 * `@/lib/enforcement/notify.ts` — should import from `@/lib/mail`, not reach
 * into individual files here.
 */
export type { MailMessage, MailTransport, SmtpTransportConfig } from './smtpTransport';
export { buildMailOptions, createSmtpTransport } from './smtpTransport';

export type { ApprovedEmailInput, DeclinedEmailInput, HeldEmail, HeldEmailInput } from './templates';
export { buildApprovedEmail, buildDeclinedEmail, buildHeldEmail } from './templates';
