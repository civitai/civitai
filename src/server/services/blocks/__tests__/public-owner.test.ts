import { describe, expect, it } from 'vitest';
import { projectPublicOwner } from '~/server/services/blocks/public-owner';

/**
 * Public owner-chip projection — node `unit` project (the BLOCKING gate).
 *
 * This projection is the ONLY thing between a real `User` row and an
 * anon-capable public read (`blocks.getAppDetail`), so the load-bearing test is
 * the mutation-style one: an arbitrary extra column present on the raw row must
 * NOT appear in the output.
 */

const row = (over: Record<string, unknown> = {}) => ({
  owner_user_id: 42,
  owner_username: 'zachlowdenzx',
  owner_image: 'abc.png',
  ...over,
});

describe('projectPublicOwner', () => {
  it('projects exactly {id, username, image}', () => {
    expect(projectPublicOwner(row())).toEqual({
      id: 42,
      username: 'zachlowdenzx',
      image: 'abc.png',
    });
  });

  it('🔒 NEVER copies any other column off the raw row', () => {
    const projected = projectPublicOwner(
      row({
        owner_email: 'secret@example.com',
        owner_muted: true,
        owner_settings: { apiKey: 'super-secret' },
      }) as Record<string, unknown>
    );
    expect(Object.keys(projected!).sort()).toEqual(['id', 'image', 'username']);
    expect(JSON.stringify(projected)).not.toContain('secret@example.com');
    expect(JSON.stringify(projected)).not.toContain('super-secret');
  });

  it('a LEFT-JOIN miss (null id) → null owner', () => {
    expect(projectPublicOwner(row({ owner_user_id: null }))).toBeNull();
    expect(projectPublicOwner({})).toBeNull();
  });

  it('a non-numeric id → null (defensive: $queryRaw is unknown-shaped)', () => {
    expect(projectPublicOwner(row({ owner_user_id: '42' }))).toBeNull();
  });

  it('a null username/image are carried through as null, not dropped', () => {
    expect(projectPublicOwner(row({ owner_username: null, owner_image: null }))).toEqual({
      id: 42,
      username: null,
      image: null,
    });
  });

  it('wrong-typed username/image degrade to null (never leak a non-string blob)', () => {
    expect(projectPublicOwner(row({ owner_username: 123, owner_image: { k: 'v' } }))).toEqual({
      id: 42,
      username: null,
      image: null,
    });
  });
});
