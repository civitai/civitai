import { describe, expect, it } from 'vitest';
import { avatarDeepLinkFields } from '../avatar-deep-link';

const fields = (query: string) => avatarDeepLinkFields(new URLSearchParams(query));

describe('avatarDeepLinkFields', () => {
  it('preselects a known style and starter character', () => {
    expect(fields('avatarStyle=voxel&avatarReference=starter:dev')).toEqual({
      avatarStyle: 'voxel',
      avatarReference: 'starter:dev',
      avatarParentImage: '',
    });
  });

  it('falls back to the cover for a missing or non-starter reference', () => {
    expect(fields('avatarStyle=voxel').avatarReference).toBe('cover');
    expect(
      fields('avatarStyle=voxel&avatarReference=https://evil.example/x.png').avatarReference
    ).toBe('cover');
  });

  it('sets nothing for an unknown or missing style', () => {
    expect(fields('avatarStyle=not-a-style&avatarReference=starter:dev')).toEqual({});
    expect(fields('')).toEqual({});
  });
});
