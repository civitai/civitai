import fs from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as Notifications from '~/utils/notifications';

const mocks = vi.hoisted(() => ({ showErrorNotification: vi.fn() }));

vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof Notifications>()),
  showErrorNotification: mocks.showErrorNotification,
}));

import { notifyUploadRejection } from '~/components/CreatorShop/upload-rejection';

const repoRoot = path.resolve(__dirname, '../../../..');
const read = (relative: string) =>
  fs.readFileSync(path.join(repoRoot, ...relative.split('/')), 'utf-8');

const rejection = (size: number, code: string) =>
  [{ file: { size, name: 'cover.webp' } as File, errors: [{ code, message: code }] }] as never;

const MB = 1024 * 1024;

/**
 * A rejected file never reaches `onDrop`, so nothing downstream — including the size row in
 * `validateCosmeticImage` — can report it. Without a handler the picker is silent, which is
 * how the 2 MB pack-cover cap surfaced as "animated covers render as a still frame"
 * (868kz1hnq) rather than as "your file was too big".
 */
describe('notifyUploadRejection', () => {
  beforeEach(() => mocks.showErrorNotification.mockClear());

  it('names both the file size and the limit when the file is too large', () => {
    notifyUploadRejection(rejection(60 * MB, 'file-too-large'), 50 * MB);

    expect(mocks.showErrorNotification).toHaveBeenCalledTimes(1);
    const { error } = mocks.showErrorNotification.mock.calls[0][0];
    // The WHOLE string, not two `toContain`s: the two numbers sit in fixed roles, and
    // asserting them separately passes just as happily on "That file is 50 MB. The limit
    // is 60 MB." — the message with the file size and the cap swapped.
    expect(error.message).toBe('That file is 60 MB. The limit is 50 MB.');
  });

  it('reports a wrong file type as a type problem, not a size one', () => {
    notifyUploadRejection(rejection(1 * MB, 'file-invalid-type'), 50 * MB);

    // Asserted before destructuring so an early-return regression fails legibly here
    // rather than dying on `Cannot destructure property 'error' of undefined`.
    expect(mocks.showErrorNotification).toHaveBeenCalledTimes(1);
    const { error } = mocks.showErrorNotification.mock.calls[0][0];
    expect(error.message).toContain('file type');
    expect(error.message).not.toContain('limit is');
  });

  // Proves the mock is not pre-populated, so the two assertions above are reading
  // calls this function actually made.
  it('says nothing when no file was rejected', () => {
    notifyUploadRejection([] as never, 50 * MB);
    expect(mocks.showErrorNotification).not.toHaveBeenCalled();
  });
});

/**
 * ⚠️ These pin a DECISION (868kz1hnq), not an incidental shape — do not delete them to make
 * an edit pass.
 *
 * A pack cover must accept what a cosmetic accepts. It used to carry its own hardcoded
 * `MAX_COVER_SIZE = 2 * 1024 * 1024` while the cosmetic path read
 * `constants.mediaUpload.maxImageFileSize` (50 MB), so the same animated WebP uploaded as a
 * sticker and vanished as a cover. Re-introducing a separate literal recreates that exactly,
 * and nothing else in the suite would notice — both files still compile and every other test
 * still passes.
 *
 * The `allowAnimatedWebP` assertion matters for the same reason and is easier to lose: with
 * the argument absent, `useCFImageUpload` falls back to `?? currentUser?.isModerator`, so the
 * feature keeps working for whoever is testing it and silently fails for creators.
 */
describe('the pack cover reads the cosmetic size limit and asks for animation itself', () => {
  const modal = () => read('src/components/CreatorShop/Pack/CreatorShopPackModal.tsx');

  it('sizes the cover dropzone from the shared constant, not a literal', () => {
    const source = modal();
    expect(source).toContain('maxSize={constants.mediaUpload.maxImageFileSize}');
    expect(source).not.toMatch(/MAX_COVER_SIZE/);
  });

  it('asks for animated WebP explicitly rather than inheriting the moderator default', () => {
    expect(modal()).toContain('allowAnimatedWebP: true');
  });

  /**
   * NOT a claim of parity, and the describe above is named to avoid implying one. The two
   * paths agree on the size limit and disagree on animation ON PURPOSE: the cosmetic form
   * passes `allowAnimatedWebP: supportsAnimated`, gated on cosmetic type, because a badge
   * or decoration is worn across the site. A cover only appears on a shop card, so it
   * always may animate — hence the hardcoded `true` pinned above.
   *
   * This asserts the disagreement rather than a similarity. The previous version checked
   * that the cosmetic file contained `'allowAnimatedWebP:'`, which is satisfied by any
   * value including `false`, and so could not fail.
   */
  it('deliberately differs from the cosmetic path on animation, and only there', () => {
    const cosmetic = read('src/components/CreatorShop/Submit/useSubmitCreatorShopForm.ts');
    expect(cosmetic).toContain('const maxSize = constants.mediaUpload.maxImageFileSize;');
    expect(cosmetic).toContain('allowAnimatedWebP: supportsAnimated');
    expect(cosmetic).not.toContain('allowAnimatedWebP: true');
  });
});

/**
 * The silent-rejection bug was in BOTH pickers — the cover at 2 MB where it bit immediately,
 * and the cosmetic artwork field at 50 MB where it just bit less often. They share one
 * handler now; this is what stops a later edit from dropping it off one of them again.
 */
describe('both CreatorShop pickers report a rejected file', () => {
  it.each([
    ['src/components/CreatorShop/Pack/PackCoverField.tsx'],
    ['src/components/CreatorShop/Submit/ArtworkField.tsx'],
  ])('%s wires onReject to the shared handler', (relative) => {
    // The conjunction, in one matcher. Asserting `toContain('notifyUploadRejection')` and
    // `/onReject=\{/` separately is satisfied by `onReject={() => {}}` with the IMPORT line
    // supplying the name — i.e. by an inert handler, which is the exact bug this guards.
    expect(read(relative)).toMatch(
      /onReject=\{\s*\([^)]*\)\s*=>\s*notifyUploadRejection\(\s*\w+\s*,\s*maxSize\s*\)/
    );
  });
});
