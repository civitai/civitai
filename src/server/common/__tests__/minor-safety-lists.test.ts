import { describe, expect, it } from 'vitest';
import {
  BAN_REASONS_ALWAYS_REMOVING_MEDIA,
  MINOR_UNPUBLISH_REASONS,
} from '@civitai/shared/held-url';
import { banReasonsAlwaysRemovingMedia } from '~/server/common/constants';
import { BanReasonCode } from '~/server/common/enums';
import { unpublishReasons } from '~/server/common/moderation-helpers';

// The shared lists also decide which retracted images only CSAM-cleared moderators see, so a code
// that stops matching here would drop that signal without an error.
describe('the shared minor-safety lists', () => {
  it('are the minor-safety ban codes, by their enum values', () => {
    expect(banReasonsAlwaysRemovingMedia).toEqual([
      BanReasonCode.SexualMinor,
      BanReasonCode.SexualMinorGenerator,
      BanReasonCode.SexualMinorTraining,
    ]);
    for (const code of BAN_REASONS_ALWAYS_REMOVING_MEDIA) expect(BanReasonCode[code]).toBe(code);
  });

  it('name unpublish reasons that exist', () => {
    for (const reason of MINOR_UNPUBLISH_REASONS)
      expect(Object.keys(unpublishReasons)).toContain(reason);
  });
});
