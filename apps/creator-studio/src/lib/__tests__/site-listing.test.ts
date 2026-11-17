import { describe, expect, it } from 'vitest';
import { Flags, NsfwLevel } from '@civitai/shared';
import { siteListing } from '../site-listing';

const level = (...levels: number[]) => Flags.arrayToInstance(levels);
const published = {
  status: 'Published',
  availability: 'Public',
  nsfwLevel: level(NsfwLevel.PG),
  mode: null,
  hasPublicVersion: true,
  poi: false,
  minor: false,
  hasPeopleTag: false,
  hasChildTag: false,
};

describe('siteListing', () => {
  it('lists an all-ages model on both sites', () => {
    expect(siteListing(published)).toMatchObject({ com: true, red: true });
  });

  it('lists a mature-only model on .red alone, and on both once a safe bit is added', () => {
    expect(siteListing({ ...published, nsfwLevel: level(NsfwLevel.X) })).toMatchObject({
      com: false,
      red: true,
    });
    expect(
      siteListing({ ...published, nsfwLevel: level(NsfwLevel.PG13, NsfwLevel.X) })
    ).toMatchObject({ com: true, red: true });
  });

  it('keeps a minor-flagged or child-tagged model off .red', () => {
    expect(siteListing({ ...published, minor: true })).toMatchObject({ com: true, red: false });
    expect(siteListing({ ...published, hasChildTag: true })).toMatchObject({
      com: true,
      red: false,
    });
  });

  it.each([
    ['a draft', { status: 'Draft' }],
    ['a private model', { availability: 'Private' }],
    ['an archived model', { mode: 'Archived' }],
    ['a taken-down model', { mode: 'TakenDown' }],
    ['a model with no public published version', { hasPublicVersion: false }],
    ['a POI model', { poi: true }],
    ['a model tagged as a real person', { hasPeopleTag: true }],
    ['an unrated model', { nsfwLevel: 0 }],
    ['a Blocked-only model', { nsfwLevel: level(NsfwLevel.Blocked) }],
  ])('lists %s on neither site', (_, override) => {
    const listing = siteListing({ ...published, ...override });
    expect(listing).toMatchObject({ com: false, red: false });
    expect(listing.note).toBeTruthy();
  });
});
