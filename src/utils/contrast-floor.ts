const channel = (c: number) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: number[]) =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

/** WCAG contrast ratio of an sRGB colour against black. */
export const contrastOnBlack = (rgb: number[]) => (luminance(rgb) + 0.05) / 0.05;

function parseHex(color: string) {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color)?.[1];
  if (!hex) return null;
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}

const toHex = (rgb: number[]) => '#' + rgb.map((c) => c.toString(16).padStart(2, '0')).join('');

/**
 * Mixes a hex colour toward white, by the least amount, until it reaches `ratio` against black.
 * Colours that already do, and anything that is not a hex colour (a theme colour name), pass through.
 */
export function liftToContrastOnBlack(color: string, ratio = 4.6) {
  const rgb = parseHex(color);
  if (!rgb || contrastOnBlack(rgb) >= ratio) return color;
  for (let step = 1; step <= 200; step++) {
    const mixed = rgb.map((c) => Math.round(c + ((255 - c) * step) / 200));
    if (contrastOnBlack(mixed) >= ratio) return toHex(mixed);
  }
  return '#ffffff';
}
