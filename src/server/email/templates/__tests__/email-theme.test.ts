import { describe, expect, it } from 'vitest';
import { emailAccents, emailTheme } from '~/server/email/templates/util';

/** WCAG 2.x contrast ratio of two #rrggbb colours. */
function contrast(a: string, b: string) {
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe('contrast', () => {
  it('computes known ratios', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    // The site's blue[6] fails AA with white text, which is why the button does not use it.
    expect(contrast('#ffffff', '#228BE6')).toBeLessThan(4.5);
    // And the old footer grey failed on white.
    expect(contrast('#888888', '#ffffff')).toBeLessThan(4.5);
  });
});

describe('email theme text meets WCAG AA (4.5:1)', () => {
  const t = emailTheme;
  it.each([
    ['button label on the button', t.buttonText, t.button],
    ['footer on the card', t.footer, t.surface],
    ['body text on the card', t.text, t.surface],
    ['muted text on the card', t.muted, t.surface],
    ['links on the card', t.link, t.surface],
    ['logo alt text on the band', t.logoAlt, t.band],
    ['dark mode: body text on the card', t.dark.text, t.dark.surface],
    ['dark mode: footer on the card', t.dark.footer, t.dark.surface],
    ['dark mode: links on the card', t.dark.link, t.dark.surface],
    ['dark mode: heading on the card', t.dark.heading, t.dark.surface],
    ['summary label on the panel', t.muted, t.panel],
    ['summary value on the panel', t.text, t.panel],
    ['dark mode: summary label on the panel', t.dark.footer, t.dark.panel],
    ['dark mode: summary value on the panel', t.dark.text, t.dark.panel],
    ['page footer links on the page', t.footer, t.outer],
    ['dark mode: page footer links on the page', t.dark.footer, t.dark.outer],
  ])('%s', (_label, fg, bg) => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  // Each accent colours text in two places: the eyebrow over the heading (on the card) and, as
  // the callout tint, the background behind body text.
  it.each(Object.entries(emailAccents))('%s accent text and tints', (_name, a) => {
    expect(contrast(a.text, t.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(a.darkText, t.dark.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t.text, a.tint)).toBeGreaterThanOrEqual(4.5);
  });

  it('gives every accent a solid colour for clients without gradients', () => {
    expect(Object.keys(emailAccents).sort()).toEqual(
      ['blue', 'buzz', 'gray', 'green', 'red', 'violet'].sort()
    );
    for (const a of Object.values(emailAccents)) {
      expect(a.solid).toMatch(/^#[0-9a-f]{6}$/i);
      expect(a.from).toMatch(/^#[0-9a-f]{6}$/i);
      expect(a.to).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('uses the site colours it names', () => {
    expect(t.band).toBe('#1A1B1E');
    expect(t.button).toBe('#1971C2');
    expect(t.surface).not.toMatch(/^#f{3}(f{3})?$/i);
  });
});
