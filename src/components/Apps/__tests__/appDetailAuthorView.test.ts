import { describe, expect, it } from 'vitest';
import { getAppDetailAuthor } from '~/components/Apps/appDetailAuthorView';

/**
 * Legacy `/apps/<appBlockId>` AUTHOR attribution — node `unit` project (the
 * BLOCKING gate).
 *
 * The regression this guards is specific and was live in prod: the page showed
 * `by {appName}`, and `OauthClient.name` equals the APP's own title for every
 * approved block — so the author slot displayed the app's title, with an opaque
 * `appId` as the fallback. The rule is now "owner username or nothing".
 */

describe('getAppDetailAuthor', () => {
  it('returns the owner chip linked to the profile', () => {
    expect(
      getAppDetailAuthor({ owner: { id: 7, username: 'zachlowdenzx', image: 'abc.png' } })
    ).toEqual({ username: 'zachlowdenzx', href: '/user/zachlowdenzx', image: 'abc.png' });
  });

  it('🔴 NEVER falls back to appName/appId — no owner means NO attribution', () => {
    // The exact prod shape of the bug: OauthClient.name === the app title.
    const detail = {
      appName: 'Gen Matrix',
      appId: 'app_01',
      owner: null,
    } as unknown as { owner: null };
    expect(getAppDetailAuthor(detail)).toBeNull();
  });

  it('a null username → null (render nothing rather than a wrong name)', () => {
    expect(getAppDetailAuthor({ owner: { id: 7, username: null, image: null } })).toBeNull();
  });

  it('a whitespace-only username → null', () => {
    expect(getAppDetailAuthor({ owner: { id: 7, username: '   ', image: null } })).toBeNull();
  });

  it('a missing owner field / undefined detail → null (no crash)', () => {
    expect(getAppDetailAuthor({})).toBeNull();
    expect(getAppDetailAuthor(undefined)).toBeNull();
    expect(getAppDetailAuthor(null)).toBeNull();
  });

  it('encodes an odd username in the profile href', () => {
    expect(getAppDetailAuthor({ owner: { id: 7, username: 'a b/c', image: null } })?.href).toBe(
      '/user/a%20b%2Fc'
    );
  });

  it('a null image is carried through as null (avatar falls back to the initial)', () => {
    expect(getAppDetailAuthor({ owner: { id: 7, username: 'bob', image: null } })?.image).toBeNull();
  });
});
