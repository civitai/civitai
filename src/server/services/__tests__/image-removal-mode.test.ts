import { describe, it, expect } from 'vitest';
import { imageRemovalMode } from '~/server/utils/image-removal-mode';

describe('imageRemovalMode', () => {
  it('returns grace only when the user explicitly opted to keep their images', () => {
    expect(imageRemovalMode(false)).toBe('grace');
  });

  it('returns immediate when the user opted to delete them', () => {
    expect(imageRemovalMode(true)).toBe('immediate');
  });

  // The 1.3M backlog accounts and any API caller that omits the field must keep
  // today's hard-delete behavior.
  it('returns immediate when the choice is absent', () => {
    expect(imageRemovalMode(undefined)).toBe('immediate');
  });
});
