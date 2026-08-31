import { describe, expect, it } from 'vitest';
import {
  CHAT_LAYOUT_DEFAULT,
  chatLayouts,
  chatLayoutSlugs,
  resolveChatLayout,
} from '~/shared/constants/chat-layout';
import {
  CHAT_THEME_DEFAULT,
  chatThemes,
  chatThemeSlugs,
  resolveChatTheme,
} from '~/shared/constants/chat-theme';

describe('chat themes', () => {
  it('has exactly one theme per slug, and no theme without one', () => {
    // The zod enum on userSettingsChat is built from chatThemeSlugs, so a theme
    // missing from it is unsavable and a slug missing a theme resolves to default
    // — both silently, and only for the person who picked it.
    expect(chatThemes.map((t) => t.slug).sort()).toEqual([...chatThemeSlugs].sort());
  });

  it('gives every membership theme the bubble tokens the Bubbles layout reads', () => {
    // .bubbles falls back to a neutral grey per token, so a theme that sets its
    // window colours but forgets --chat-bubble reads as unthemed in that layout
    // rather than failing outright.
    for (const theme of chatThemes.filter((t) => t.slug !== CHAT_THEME_DEFAULT)) {
      expect(theme.vars, theme.slug).toBeTruthy();
      expect(Object.keys(theme.vars ?? {}), theme.slug).toEqual(
        expect.arrayContaining(['--chat-bubble', '--chat-bubble-me'])
      );
    }
  });

  it('gives every membership theme its own text colour', () => {
    // The window paints `color: var(--chat-text)`, whose stock value is
    // `inherit` — so a theme that skips it inherits the app's light/dark text
    // onto a fixed palette, which is white-on-cream for the light themes.
    for (const theme of chatThemes.filter((t) => t.slug !== CHAT_THEME_DEFAULT)) {
      expect(theme.vars?.['--chat-text'], theme.slug).toMatch(/^#[0-9a-f]{3,8}$/i);
    }
  });

  it('leaves the default theme without vars so the app tokens show through', () => {
    expect(chatThemes.find((t) => t.slug === CHAT_THEME_DEFAULT)?.vars).toBeNull();
  });

  it('offers the default free and everything else behind a membership', () => {
    expect(chatThemes.filter((t) => t.free).map((t) => t.slug)).toEqual([CHAT_THEME_DEFAULT]);
  });

  it('paints a non-member the default rather than the theme they used to have', () => {
    expect(resolveChatTheme('violet', false).slug).toBe(CHAT_THEME_DEFAULT);
    expect(resolveChatTheme('violet', true).slug).toBe('violet');
  });

  it('falls back to the default for a slug that no longer exists', () => {
    expect(resolveChatTheme('retired-theme', true).slug).toBe(CHAT_THEME_DEFAULT);
    expect(resolveChatTheme(undefined, true).slug).toBe(CHAT_THEME_DEFAULT);
  });
});

describe('chat layouts', () => {
  it('has exactly one layout per slug, and no layout without one', () => {
    expect(chatLayouts.map((l) => l.slug).sort()).toEqual([...chatLayoutSlugs].sort());
  });

  it('resolves a stored layout, and anything unrecognised to stacked', () => {
    expect(resolveChatLayout('bubbles')).toBe('bubbles');
    expect(resolveChatLayout('stacked')).toBe('stacked');
    expect(resolveChatLayout(undefined)).toBe(CHAT_LAYOUT_DEFAULT);
    expect(resolveChatLayout('sidebar')).toBe(CHAT_LAYOUT_DEFAULT);
  });

  it('keeps stacked as the default, so nobody is re-laid-out without asking', () => {
    expect(CHAT_LAYOUT_DEFAULT).toBe('stacked');
  });
});
