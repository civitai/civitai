import { describe, expect, it } from 'vitest';
import { getSanitizedStringSchema } from '~/server/schema/utils.schema';
import {
  restoreWithheldMedia,
  withheldMediaPlaceholders,
} from '~/server/utils/article-withheld-media';

const HIDDEN = '11111111-aaaa-4bbb-8ccc-111111111111';
const SHOWN = '22222222-aaaa-4bbb-8ccc-222222222222';
const img = (uuid: string) =>
  `<img src="https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/${uuid}/width=450">`;
const stored =
  `<p>one</p>${img(SHOWN)}<p>two ${img(HIDDEN)} three</p>` +
  `<edge-media url="${HIDDEN}" type="video"></edge-media><p>end</p>`;
const hidden = new Set([HIDDEN]);

describe('the edit form body', () => {
  const edited = withheldMediaPlaceholders(stored, hidden);

  it('names no hidden image, and keeps the shown one', () => {
    expect(edited).not.toContain(HIDDEN);
    expect(edited).toContain(img(SHOWN));
    expect(edited.match(/data-type="withheldMedia"/g)).toHaveLength(2);
  });

  it('🔴 saves back byte for byte when nothing changed', () => {
    expect(restoreWithheldMedia(edited, stored, hidden)).toBe(stored);
  });

  it('survives the save sanitizer', () => {
    const sanitized = getSanitizedStringSchema({ allowBlurbs: true }).parse(edited);
    expect(restoreWithheldMedia(sanitized, stored, hidden)).toContain(img(HIDDEN));
  });

  it('keeps the other placeholders when one is deleted', () => {
    const [first] = edited.match(/<span data-type="withheldMedia" data-id="\d+"><\/span>/)!;
    const restored = restoreWithheldMedia(edited.replace(first, ''), stored, hidden);
    expect(restored).not.toContain(img(HIDDEN));
    expect(restored).toContain(`<edge-media url="${HIDDEN}"`);
  });

  it.each([
    ['a shown image', 0],
    ['no stored image', 9],
  ])('🔴 refuses a placeholder that names %s', (_, ref) => {
    const forged = `<p>x</p><span data-type="withheldMedia" data-id="${ref}"></span>`;
    expect(() => restoreWithheldMedia(forged, stored, hidden)).toThrow();
  });

  it('🔴 refuses one placeholder named twice', () => {
    const twice = `<span data-type="withheldMedia" data-id="1"></span>`.repeat(2);
    expect(() => restoreWithheldMedia(twice, stored, hidden)).toThrow();
  });

  it('🔴 refuses any placeholder on a body with nothing stored', () => {
    const forged = `<span data-type="withheldMedia" data-id="0"></span>`;
    expect(() => restoreWithheldMedia(forged, null, hidden)).toThrow();
  });

  it('leaves a body without placeholders untouched (control)', () => {
    expect(restoreWithheldMedia('<p>new</p>', stored, hidden)).toBe('<p>new</p>');
    expect(withheldMediaPlaceholders(stored, new Set())).toBe(stored);
  });
});
