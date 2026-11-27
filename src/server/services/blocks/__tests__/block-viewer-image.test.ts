import { describe, expect, it } from 'vitest';
import { blockOutputCeilingFromClaims } from '~/server/services/blocks/block-output-restriction';
import { projectBlockViewerImage } from '~/server/services/blocks/block-viewer-image';

/**
 * The viewer's avatar as an App Block sees it (`/blocks/me`, `blocks.getMyViewer`,
 * `BLOCK_INIT.viewer.image`). The ceiling is the REAL `blockOutputCeilingFromClaims` — the
 * same one workflow outputs are judged against — never a hand-built bitflag, so a change
 * to the output ceiling moves these cases with it.
 *
 * Each case's image key is distinct so a url can only come from the picture it names.
 */

const VIEWER_ANY = 1 | 2 | 4 | 8 | 16;
// A signed-in viewer on an SFW domain (green/blue): PG | PG13.
const SFW_APP = blockOutputCeilingFromClaims({
  sub: 'user:42',
  maxBrowsingLevel: 1 | 2,
  viewerBrowsingLevel: VIEWER_ANY,
});
// A signed-in viewer with every level on the mature domain (red): PG through XXX.
const MATURE_APP = blockOutputCeilingFromClaims({
  sub: 'user:42',
  maxBrowsingLevel: 1 | 2 | 4 | 8 | 16,
  viewerBrowsingLevel: VIEWER_ANY,
});
// The mature domain, but a viewer whose own level is PG only. The PG-13 floor for a
// signed-in viewer lifts it to PG | PG13, and no further.
const MATURE_APP_SFW_VIEWER = blockOutputCeilingFromClaims({
  sub: 'user:42',
  maxBrowsingLevel: 1 | 2 | 4 | 8 | 16,
  viewerBrowsingLevel: 1,
});

const scanned = (url: string, nsfwLevel: number) => ({
  image: null,
  profilePicture: { url, nsfwLevel, ingestion: 'Scanned' },
});

describe('projectBlockViewerImage', () => {
  it('an X avatar in an SFW app is WITHHELD — no url, no rating', () => {
    const out = projectBlockViewerImage(scanned('key-x-sfw', 8), SFW_APP);
    expect(out).toEqual({ restricted: true });
    expect(JSON.stringify(out)).not.toContain('key-x-sfw');
  });

  it('the same X avatar in a mature app, for a viewer who allows X, is a url with its rating', () => {
    expect(projectBlockViewerImage(scanned('key-x-red', 8), MATURE_APP)).toEqual({
      url: expect.stringMatching(
        /(^|\/)key-x-red\/anim=false,width=320,optimized=true\/key-x-red\.jpeg$/
      ),
      nsfwLevel: 'x',
    });
  });

  it('an R avatar in a mature app is withheld from a viewer whose own level is SFW', () => {
    expect(projectBlockViewerImage(scanned('key-r-sfwviewer', 4), MATURE_APP_SFW_VIEWER)).toEqual({
      restricted: true,
    });
  });

  it('PG and PG-13 avatars pass an SFW app, with the rating in the output vocabulary', () => {
    expect(projectBlockViewerImage(scanned('key-pg', 1), SFW_APP)).toEqual({
      url: expect.stringMatching(
        /(^|\/)key-pg\/anim=false,width=320,optimized=true\/key-pg\.jpeg$/
      ),
      nsfwLevel: 'pg',
    });
    expect(projectBlockViewerImage(scanned('key-pg13', 2), SFW_APP)).toEqual({
      url: expect.stringMatching(
        /(^|\/)key-pg13\/anim=false,width=320,optimized=true\/key-pg13\.jpeg$/
      ),
      nsfwLevel: 'pg13',
    });
  });

  it('an avatar still being scanned is withheld as unrated, even in a mature app', () => {
    for (const ingestion of ['Pending', 'Error', 'NotFound', 'Rescan', 'PendingManualAssignment']) {
      expect(
        projectBlockViewerImage(
          { profilePicture: { url: `key-${ingestion}`, nsfwLevel: 1, ingestion } },
          MATURE_APP
        )
      ).toEqual({ restricted: true });
    }
  });

  it('a scanned avatar with no level (0) is withheld as unrated', () => {
    expect(projectBlockViewerImage(scanned('key-zero', 0), MATURE_APP)).toEqual({
      restricted: true,
    });
  });

  it('a level that is not exactly one rating (Blocked, a multi-bit flag) fails closed', () => {
    expect(projectBlockViewerImage(scanned('key-blockedlevel', 32), MATURE_APP)).toEqual({
      restricted: true,
    });
    expect(projectBlockViewerImage(scanned('key-multibit', 1 | 8), MATURE_APP)).toEqual({
      restricted: true,
    });
  });

  it('a picture blocked by moderation is no avatar at all', () => {
    expect(
      projectBlockViewerImage(
        { profilePicture: { url: 'key-blocked', nsfwLevel: 1, ingestion: 'Blocked' } },
        MATURE_APP
      )
    ).toBeNull();
  });

  it('a legacy unrated avatar url is withheld as unrated; no avatar at all is null', () => {
    expect(
      projectBlockViewerImage(
        { image: 'https://avatars.example/legacy.png', profilePicture: null },
        MATURE_APP
      )
    ).toEqual({ restricted: true });
    expect(projectBlockViewerImage({ image: null, profilePicture: null }, MATURE_APP)).toBeNull();
    expect(projectBlockViewerImage(null, MATURE_APP)).toBeNull();
  });

  it('a dead blob: profile picture falls back to the legacy url rule', () => {
    expect(
      projectBlockViewerImage(
        {
          image: null,
          profilePicture: { url: 'blob:https://x/1', nsfwLevel: 1, ingestion: 'Scanned' },
        },
        MATURE_APP
      )
    ).toBeNull();
  });

  it('a token with no viewer level fails closed to PG', () => {
    const noViewerLevel = blockOutputCeilingFromClaims({ sub: 'user:42', maxBrowsingLevel: 31 });
    expect(projectBlockViewerImage(scanned('key-pg13-nolevel', 2), noViewerLevel)).toEqual({
      restricted: true,
    });
  });
});
