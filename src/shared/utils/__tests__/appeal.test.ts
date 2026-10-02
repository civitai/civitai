import { describe, expect, it } from 'vitest';
import {
  APPEAL_ALREADY_DECIDED,
  APPEAL_ALREADY_PENDING,
  getAppealRefusal,
  isAppealableImage,
  isAppealableModel3D,
} from '~/shared/utils/appeal';
import { AppealStatus, Model3DStatus } from '~/shared/utils/prisma/enums';

describe('getAppealRefusal', () => {
  it.each([
    [null, null],
    [AppealStatus.Approved, null],
    [AppealStatus.Void, null],
    [AppealStatus.Pending, APPEAL_ALREADY_PENDING],
    [AppealStatus.Rejected, APPEAL_ALREADY_DECIDED],
  ])('latest appeal %s -> %s', (status, expected) => {
    expect(getAppealRefusal(status ? { status } : null)).toBe(expected);
  });
});

describe('isAppealableImage', () => {
  it.each([
    [{ blockedFor: 'moderated', needsReview: null }, true],
    [{ blockedFor: 'Moderated', needsReview: null }, true],
    [{ blockedFor: 'moderated', needsReview: 'appeal' }, false],
    [{ blockedFor: 'AiNotVerified', needsReview: null }, false],
    [{ blockedFor: null, needsReview: null }, false],
  ])('%o -> %s', (image, expected) => {
    expect(isAppealableImage(image)).toBe(expected);
  });
});

describe('isAppealableModel3D', () => {
  it.each([
    [Model3DStatus.Unpublished, true],
    [Model3DStatus.Deleted, true],
    [Model3DStatus.Published, false],
    [Model3DStatus.Draft, false],
  ])('%s -> %s', (status, expected) => {
    expect(isAppealableModel3D({ status })).toBe(expected);
  });
});
