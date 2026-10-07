import nodemailer from 'nodemailer';
import { describe, expect, it } from 'vitest';
import { buildMailOptions, createSmtpTransport } from '@/lib/mail/smtpTransport';

/**
 * `src/lib/mail/smtpTransport.ts` — the `nodemailer`-backed replacement for
 * the old hand-rolled `node:net`/`node:tls` client (`message.ts`,
 * `protocol.ts`, deleted). No test here opens a real SMTP connection or
 * sends real mail (this task's constraint); the non-ASCII tests below drive
 * the actual built message through `nodemailer`'s own `streamTransport`
 * (`buffer: true` — fully in-memory, no I/O), which builds the exact bytes
 * that would go on the wire without connecting anywhere.
 *
 * The old `message.ts` had NO RFC 2047 encoded-word support — its own
 * comment said so — and would have written raw UTF-8 bytes straight into a
 * `Subject:` header, which is not legal RFC 5322/2047. That was latent
 * (today's subjects are fixed ASCII), but the library already holds titles
 * like `Les Misérables` and `Naked Gun 33⅓`, and putting a title in a
 * subject or body is an obvious next step. These tests prove the specific
 * defect is gone: non-ASCII text is never emitted as raw bytes in a header,
 * it IS properly encoded (RFC 2047 for headers, quoted-printable for the
 * body), and decoding that encoding round-trips back to the exact original
 * text.
 */

function decodeQuotedPrintable(input: string): string {
  const withoutSoftBreaks = input.replace(/=\r\n/g, '').replace(/=\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < withoutSoftBreaks.length; i++) {
    const ch = withoutSoftBreaks[i];
    const hex = withoutSoftBreaks.slice(i + 1, i + 3);
    if (ch === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(ch.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString('utf-8');
}

/** Decodes an RFC 2047 encoded-word header value (`=?UTF-8?Q?...?=` / `=?UTF-8?B?...?=`), including one nodemailer folded across multiple encoded-words on continuation lines (RFC 2047 §6.2: whitespace between two adjacent encoded-words is not part of the decoded text). */
function decodeRfc2047Header(rawHeaderValue: string): string {
  const unfolded = rawHeaderValue.replace(/\r\n[ \t]+/g, ' ');
  const joinedAdjacentWords = unfolded.replace(/\?=\s+=\?/g, '?==?');
  return joinedAdjacentWords.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_match, _charset, encoding, text) => {
    if (encoding.toUpperCase() === 'B') return Buffer.from(text, 'base64').toString('utf-8');
    return decodeQuotedPrintable(text.replace(/_/g, ' '));
  });
}

/** Extracts one header's full (possibly folded) raw value out of a CRLF-terminated raw message. */
function headerValue(rawMessage: string, name: string): string {
  const lines = rawMessage.split('\r\n');
  const startIndex = lines.findIndex((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  if (startIndex === -1) throw new Error(`header ${name} not found in:\n${rawMessage}`);
  let value = lines[startIndex].slice(lines[startIndex].indexOf(':') + 1).trim();
  for (let i = startIndex + 1; i < lines.length && /^[ \t]/.test(lines[i]); i++) {
    value += `\r\n ${lines[i].trim()}`;
  }
  return value;
}

/** Builds the exact wire bytes `buildMailOptions`'s output would produce, via nodemailer's in-memory streamTransport — no socket, no I/O. */
async function renderRaw(options: ReturnType<typeof buildMailOptions>): Promise<string> {
  const transporter = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const info = await transporter.sendMail(options);
  return (info.message as Buffer).toString('utf-8');
}

describe('buildMailOptions', () => {
  it('wraps from in a {name, address} object when fromName is given', () => {
    const options = buildMailOptions({ from: 'quota@example.com', fromName: 'seerr-quota' }, { to: 'frank@example.com', subject: 's', text: 't' });
    expect(options.from).toEqual({ name: 'seerr-quota', address: 'quota@example.com' });
    expect(options.to).toBe('frank@example.com');
    expect(options.subject).toBe('s');
    expect(options.text).toBe('t');
  });

  it('uses a bare address string for from when no fromName is given', () => {
    const options = buildMailOptions({ from: 'quota@example.com' }, { to: 'frank@example.com', subject: 's', text: 't' });
    expect(options.from).toBe('quota@example.com');
  });
});

describe('createSmtpTransport', () => {
  it('constructs without opening a connection (no real SMTP connection in any test)', () => {
    expect(() =>
      createSmtpTransport({ host: 'mail.example.com', port: 25, user: 'u', pass: 'p', from: 'quota@example.com', fromName: 'seerr-quota' }),
    ).not.toThrow();
  });
});

describe('non-ASCII subject/body survive real nodemailer encoding (the defect the old hand-rolled client had)', () => {
  it('encodes a non-ASCII Subject as an RFC 2047 encoded-word, never as raw bytes, and round-trips exactly', async () => {
    const subject = 'Your request for Les Misérables is on hold';
    const options = buildMailOptions({ from: 'quota@example.com', fromName: 'seerr-quota' }, { to: 'frank@example.com', subject, text: 'placeholder' });

    const raw = await renderRaw(options);
    const subjectHeader = headerValue(raw, 'Subject');

    expect(subjectHeader).not.toContain('Misérables'); // never raw UTF-8 bytes in the header
    expect(subjectHeader).toContain('=?UTF-8?'); // an RFC 2047 encoded-word was actually used
    expect(decodeRfc2047Header(subjectHeader)).toBe(subject); // and it decodes back to the exact original
  });

  it('encodes a non-ASCII body (curly apostrophe) as quoted-printable, never as raw bytes, and round-trips exactly', async () => {
    const text = 'We can’t approve this until you free up space.'; // U+2019 RIGHT SINGLE QUOTATION MARK
    const options = buildMailOptions({ from: 'quota@example.com', fromName: 'seerr-quota' }, { to: 'frank@example.com', subject: 'placeholder', text });

    const raw = await renderRaw(options);
    const [, body] = raw.split('\r\n\r\n');

    expect(raw.toLowerCase()).toContain('content-transfer-encoding: quoted-printable');
    expect(body).not.toContain('’'); // never the raw 3-byte UTF-8 sequence, unescaped
    expect(body).toContain('=E2=80=99'); // hex-escaped instead
    expect(decodeQuotedPrintable(body.trim())).toBe(text);
  });

  it('a title mixing a colon and a non-ASCII fraction survives too (Naked Gun 33⅓)', async () => {
    const subject = 'seerr-quota: your request for Naked Gun 33⅓ is on hold'; // U+2153 VULGAR FRACTION ONE THIRD
    const options = buildMailOptions({ from: 'quota@example.com', fromName: 'seerr-quota' }, { to: 'frank@example.com', subject, text: 'x' });

    const raw = await renderRaw(options);
    const subjectHeader = headerValue(raw, 'Subject');

    expect(subjectHeader).not.toContain('⅓');
    expect(decodeRfc2047Header(subjectHeader)).toBe(subject);
  });
});
