import { describe, expect, it } from 'vitest';
import { DEFAULT_APP_NAME, DEFAULT_FAVICON_URL, resolveThemeConfig } from '@/lib/theme/config';

describe('resolveThemeConfig (pure: env in, ThemeConfig out)', () => {
  it('defaults every field when the env has none of the three vars set', () => {
    expect(resolveThemeConfig({})).toEqual({
      themeCssPath: undefined,
      appName: DEFAULT_APP_NAME,
      faviconUrl: DEFAULT_FAVICON_URL,
    });
  });

  it('reads THEME_CSS, APP_NAME, and FAVICON_URL when set', () => {
    const cfg = resolveThemeConfig({
      THEME_CSS: '/theme/override.css',
      APP_NAME: 'My Instance',
      FAVICON_URL: '/custom-favicon.svg',
    });
    expect(cfg).toEqual({
      themeCssPath: '/theme/override.css',
      appName: 'My Instance',
      faviconUrl: '/custom-favicon.svg',
    });
  });

  it('treats a blank/whitespace-only THEME_CSS as unset', () => {
    expect(resolveThemeConfig({ THEME_CSS: '   ' }).themeCssPath).toBeUndefined();
  });

  it('treats a blank APP_NAME as unset and falls back to the default', () => {
    expect(resolveThemeConfig({ APP_NAME: '' }).appName).toBe(DEFAULT_APP_NAME);
  });

  it('treats a blank FAVICON_URL as unset and falls back to the default', () => {
    expect(resolveThemeConfig({ FAVICON_URL: '  ' }).faviconUrl).toBe(DEFAULT_FAVICON_URL);
  });

  it('trims surrounding whitespace from every value', () => {
    const cfg = resolveThemeConfig({ THEME_CSS: '  /x.css  ', APP_NAME: '  Name  ', FAVICON_URL: '  /f.svg  ' });
    expect(cfg).toEqual({ themeCssPath: '/x.css', appName: 'Name', faviconUrl: '/f.svg' });
  });

  it('never touches the filesystem — THEME_CSS pointing at a nonexistent file still resolves (existence is the route handler\'s problem)', () => {
    expect(resolveThemeConfig({ THEME_CSS: '/does/not/exist.css' }).themeCssPath).toBe('/does/not/exist.css');
  });
});
