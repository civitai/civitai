import { describe, expect, it } from 'vitest';
import { canViewPoiModel } from '~/server/utils/poi-model-visibility';

const OWNER = 7;

describe('canViewPoiModel', () => {
  it.each([
    ['anonymous', OWNER, undefined],
    ['a null viewer', OWNER, null],
    ['a viewer with no id', OWNER, {}],
    ['a viewer with id 0', 0, { id: 0 }],
    ['any viewer when the owner is gone', null, { id: OWNER }],
    ['a signed-in non-owner', OWNER, { id: 8, isModerator: false }],
  ])('hides a flagged model from %s', (_label, ownerId, viewer) => {
    expect(canViewPoiModel(true, ownerId, viewer)).toBe(false);
  });

  it.each([
    ['the owner', OWNER, { id: OWNER, isModerator: false }],
    ['the owner, ids compared as numbers', OWNER, { id: Number(String(OWNER)) }],
    ['a moderator', OWNER, { id: 1, isModerator: true }],
    ['a moderator, owner gone', null, { id: 1, isModerator: true }],
  ])('shows a flagged model to %s', (_label, ownerId, viewer) => {
    expect(canViewPoiModel(true, ownerId, viewer)).toBe(true);
  });

  it.each([undefined, null, { id: 8 }])('shows an unflagged model to %j', (viewer) => {
    expect(canViewPoiModel(false, OWNER, viewer)).toBe(true);
    expect(canViewPoiModel(null, OWNER, viewer)).toBe(true);
  });
});
