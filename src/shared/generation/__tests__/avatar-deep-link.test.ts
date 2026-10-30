import { describe, expect, it } from 'vitest';
import { avatarDeepLinkFields } from '../avatar-deep-link';

const fields = (query: string) => avatarDeepLinkFields(new URLSearchParams(query));

describe('avatarDeepLinkFields', () => {
  it('preselects a known style and starter character', () => {
    expect(fields('avatarStyle=voxel&avatarReference=dev')).toEqual({
      avatarStyle: 'voxel',
      avatarReference: 'dev',
      avatarParentImage: '',
    });
  });

  it('falls back to the first character for a missing or unknown reference', () => {
    expect(fields('avatarStyle=voxel').avatarReference).toBe('mara');
    expect(
      fields('avatarStyle=voxel&avatarReference=https://evil.example/x.png').avatarReference
    ).toBe('mara');
  });

  it('sets nothing for an unknown or missing style', () => {
    expect(fields('avatarStyle=not-a-style&avatarReference=dev')).toEqual({});
    expect(fields('')).toEqual({});
  });
});
