import { describe, expect, it } from 'vitest';
import { helpCookie } from './fervor-help';

describe('helpCookie', () => {
  it('remembers a collapse for a year across the site', () => {
    expect(helpCookie(true)).toBe(
      'knights_fervor_help=closed; path=/; max-age=31536000; SameSite=Lax'
    );
  });

  it('forgets it when the panel is opened again', () => {
    expect(helpCookie(false)).toContain('max-age=0');
  });
});
