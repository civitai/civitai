import { describe, expect, it, vi } from 'vitest';

import { studioPublishUrl } from '~/components/Training/studio-publish-url';
import {
  PUBLISH_PATH,
  publishSearchParams,
  publishShareChoice,
} from '../../../apps/training-studio/src/lib/publish-url-core';

import '~/__tests__/mocks/db.mock';

vi.mock('~/server/services/model-file.service', () => ({}));
const { trainingDataShareFromQuery } = await import(
  '~/server/services/training-data-share.service'
);

// No shared import spans the main app and apps/*, so this holds the embedded host's publish link
// to the studio shell's: a choice dropped by either never reaches the publish entry.
const studioLink = (req: Parameters<typeof publishSearchParams>[0]) =>
  `${PUBLISH_PATH}?${publishSearchParams(req)}`;
const shareFrom = (link: string) =>
  trainingDataShareFromQuery(Object.fromEntries(new URL(link, 'https://x.test').searchParams));

describe('the Training Studio publish link', () => {
  it.each([
    ['shared', { ownRights: true, shareDataset: true }],
    ['rights only', { ownRights: true, shareDataset: false }],
    ['nothing ticked', { ownRights: false, shareDataset: false }],
    ['share without the rights', { ownRights: false, shareDataset: true }],
    ['no choice given', {}],
  ])('is the same from both hosts: %s', (_, choice) => {
    const req = { workflowId: 'wf-1', epoch: 3, ...choice };
    expect(studioPublishUrl(req)).toBe(studioLink(req));
  });

  it('carries the choice to the publish entry, and an un-tick as an explicit not-shared', () => {
    const req = { workflowId: 'wf-1', epoch: 3 };
    expect(shareFrom(studioPublishUrl({ ...req, ownRights: true, shareDataset: true }))).toEqual({
      ownRights: true,
      shareDataset: true,
    });
    expect(shareFrom(studioPublishUrl({ ...req, ownRights: false, shareDataset: false }))).toEqual({
      ownRights: false,
      shareDataset: false,
    });
  });

  it('reopening Publish with the boxes untouched carries no choice, so a stored share stays', () => {
    const req = { workflowId: 'wf-1', epoch: 3 };
    const untouched = publishShareChoice(false, false, false);
    expect(shareFrom(studioLink({ ...req, ...untouched }))).toBeUndefined();
    expect(shareFrom(studioPublishUrl({ ...req, ...untouched }))).toBeUndefined();
  });

  it('a touched box carries the choice, an untick included', () => {
    const req = { workflowId: 'wf-1', epoch: 3 };
    expect(shareFrom(studioLink({ ...req, ...publishShareChoice(true, false, false) }))).toEqual({
      ownRights: false,
      shareDataset: false,
    });
    expect(shareFrom(studioLink({ ...req, ...publishShareChoice(true, true, true) }))).toEqual({
      ownRights: true,
      shareDataset: true,
    });
  });
});
