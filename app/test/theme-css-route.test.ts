import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/theme.css/route';
import { __resetThemeConfigForTests } from '@/lib/theme/config';

function req(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(new Request('http://localhost/theme.css', { headers }));
}

const ORIGINAL_THEME_CSS = process.env.THEME_CSS;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-theme-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (ORIGINAL_THEME_CSS === undefined) {
    delete process.env.THEME_CSS;
  } else {
    process.env.THEME_CSS = ORIGINAL_THEME_CSS;
  }
  __resetThemeConfigForTests();
});

describe('GET /theme.css', () => {
  it('404s with an empty body when THEME_CSS is unset', async () => {
    delete process.env.THEME_CSS;
    __resetThemeConfigForTests();
    const res = await GET(req());
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('');
  });

  it('404s when THEME_CSS points at a file that does not exist', async () => {
    process.env.THEME_CSS = path.join(tmpDir, 'missing.css');
    __resetThemeConfigForTests();
    const res = await GET(req());
    expect(res.status).toBe(404);
  });

  it('404s when THEME_CSS points at a directory, not a file', async () => {
    process.env.THEME_CSS = tmpDir;
    __resetThemeConfigForTests();
    const res = await GET(req());
    expect(res.status).toBe(404);
  });

  it('serves the file contents verbatim with a CSS content type when THEME_CSS points at a real file', async () => {
    const file = path.join(tmpDir, 'override.css');
    fs.writeFileSync(file, ':root { --sq-accent: #ff0000; }\n');
    process.env.THEME_CSS = file;
    __resetThemeConfigForTests();

    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/css/);
    expect(await res.text()).toBe(':root { --sq-accent: #ff0000; }\n');
  });

  it('sets Cache-Control: private, max-age=60 exactly', async () => {
    const file = path.join(tmpDir, 'override.css');
    fs.writeFileSync(file, ':root {}\n');
    process.env.THEME_CSS = file;
    __resetThemeConfigForTests();

    const res = await GET(req());
    expect(res.headers.get('cache-control')).toBe('private, max-age=60');
  });

  it('sets Last-Modified to the file mtime', async () => {
    const file = path.join(tmpDir, 'override.css');
    fs.writeFileSync(file, ':root {}\n');
    process.env.THEME_CSS = file;
    __resetThemeConfigForTests();

    const stat = fs.statSync(file);
    const res = await GET(req());
    expect(res.headers.get('last-modified')).toBe(stat.mtime.toUTCString());
  });

  it('304s with an empty body when If-Modified-Since matches the file mtime', async () => {
    const file = path.join(tmpDir, 'override.css');
    fs.writeFileSync(file, ':root {}\n');
    process.env.THEME_CSS = file;
    __resetThemeConfigForTests();

    const stat = fs.statSync(file);
    const res = await GET(req({ 'if-modified-since': stat.mtime.toUTCString() }));
    expect(res.status).toBe(304);
    expect(await res.text()).toBe('');
  });

  it('304s when If-Modified-Since is AFTER the file mtime (client cache still fresh)', async () => {
    const file = path.join(tmpDir, 'override.css');
    fs.writeFileSync(file, ':root {}\n');
    process.env.THEME_CSS = file;
    __resetThemeConfigForTests();

    const future = new Date(Date.now() + 60_000);
    const res = await GET(req({ 'if-modified-since': future.toUTCString() }));
    expect(res.status).toBe(304);
  });

  it('serves 200 with the full body when If-Modified-Since is BEFORE the file mtime (changed since)', async () => {
    const file = path.join(tmpDir, 'override.css');
    fs.writeFileSync(file, ':root { --sq-accent: #00ff00; }\n');
    process.env.THEME_CSS = file;
    __resetThemeConfigForTests();

    const past = new Date(Date.now() - 60_000);
    const res = await GET(req({ 'if-modified-since': past.toUTCString() }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(':root { --sq-accent: #00ff00; }\n');
  });

  it('ignores a malformed If-Modified-Since header and serves 200', async () => {
    const file = path.join(tmpDir, 'override.css');
    fs.writeFileSync(file, ':root {}\n');
    process.env.THEME_CSS = file;
    __resetThemeConfigForTests();

    const res = await GET(req({ 'if-modified-since': 'not-a-date' }));
    expect(res.status).toBe(200);
  });
});
