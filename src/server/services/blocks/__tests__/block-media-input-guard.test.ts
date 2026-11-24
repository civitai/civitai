import client from 'prom-client';
import { describe, expect, it } from 'vitest';
import '~/__tests__/mocks/logging.mock';
import {
  assertNoBlockMediaInputs,
  containsBlockMediaReference,
  isBlockMediaReference,
} from '~/server/services/blocks/block-media-input-guard';
import {
  blockMediaUrl,
  sealBlockMediaRef,
  sealBlockMediaTicket,
} from '~/server/services/blocks/block-media-token';

const TOKEN = `bm1.${'I'.repeat(16)}.${'C'.repeat(40)}.${'T'.repeat(22)}`;
const PATH = `/api/v1/blocks/media/${TOKEN}`;

describe('isBlockMediaReference: no spelling gets a ticket past the guard', () => {
  it.each([
    ['the relative url as minted', PATH],
    ['an absolute url', `https://civitai.com${PATH}`],
    ['www', `https://www.civitai.com${PATH}`],
    ['another Civitai host', `https://civitai.red${PATH}`],
    ['a subdomain', `https://image.civitai.green${PATH}`],
    ['upper case', `https://CIVITAI.COM${PATH.toUpperCase()}`],
    ['a trailing slash', `https://civitai.com${PATH}/`],
    ['a query string', `https://civitai.com${PATH}?w=512`],
    ['a fragment', `https://civitai.com${PATH}#x`],
    ['encoded slashes', `https://civitai.com/api%2Fv1%2Fblocks%2Fmedia%2F${TOKEN}`],
    ['double-encoded slashes', `https://civitai.com/api%252Fv1%252Fblocks%252Fmedia%252F${TOKEN}`],
    ['backslashes', `https://civitai.com\\api\\v1\\blocks\\media\\${TOKEN}`],
    ['doubled slashes', `https://civitai.com//api//v1/blocks//media/${TOKEN}`],
    ['the path with no token', 'https://civitai.com/api/v1/blocks/media'],
    ['a bare ref or ticket token', TOKEN],
    ['a token inside text', `use ${TOKEN} here`],
    ['a malformed escape beside the path', `https://civitai.com/%zz/api%2Fv1/blocks/media/x`],
  ])('%s', (_, value) => {
    expect(isBlockMediaReference(value)).toBe(true);
  });

  it.each([
    ['a Civitai image page', 'https://civitai.com/images/1'],
    ['a CDN image', 'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/abc/width=512/a.jpeg'],
    ['a version string with the prefix', 'bm1.2.3.4'],
    ['a sibling api path', 'https://civitai.com/api/v1/blocks/mediator'],
    ['prose', 'a cat in a hat'],
  ])('CONTROL: %s is not host media', (_, value) => {
    expect(isBlockMediaReference(value)).toBe(false);
  });
});

describe('containsBlockMediaReference', () => {
  it('finds a ticket anywhere in a body, at any depth', () => {
    expect(
      containsBlockMediaReference({ steps: [{ input: { images: ['a', { url: PATH }] } }] })
    ).toBe(true);
  });

  it('CONTROL: a body with no host media passes', () => {
    expect(containsBlockMediaReference({ steps: [{ input: { prompt: 'a cat', n: 2 } }] })).toBe(
      false
    );
  });

  it('a body nested past the walk bound is refused, never waved through', () => {
    let deep: unknown = 'x';
    for (let i = 0; i < 300; i++) deep = [deep];
    expect(containsBlockMediaReference(deep)).toBe(true);
  });
});

describe('🔴 tied to the mint: whatever the media route issues, the guard refuses', () => {
  const minted = {
    blobId: 'BLOB1',
    workflowId: 'wf-1',
    ownerId: 7,
    appBlockId: 'apb_1',
    mediaType: 'image' as const,
    privateGen: false,
    neverRatedVideoStep: false,
  };

  it('a ticket url exactly as blockMediaUrl builds it', () => {
    const ticket = sealBlockMediaTicket({ ...minted, viewerId: 7, viewerBrowsingLevel: 1 });
    expect(ticket).toBeTruthy();
    expect(isBlockMediaReference(blockMediaUrl(ticket!))).toBe(true);
    expect(isBlockMediaReference(`https://civitai.com${blockMediaUrl(ticket!)}`)).toBe(true);
  });

  it('a bare ticket and a bare ref, as sealed', () => {
    const ticket = sealBlockMediaTicket({ ...minted, viewerId: 7, viewerBrowsingLevel: 1 });
    const ref = sealBlockMediaRef(minted);
    expect(isBlockMediaReference(ticket!)).toBe(true);
    expect(isBlockMediaReference(ref!)).toBe(true);
  });
});

describe('a refused body is counted by phase', () => {
  const refusals = async (phase: string) => {
    const metric = client.register.getSingleMetric('civitai_app_block_media_input_refused_total');
    const values = metric ? (await metric.get()).values : [];
    return values.find((v) => v.labels.phase === phase)?.value ?? 0;
  };

  it('one refused submit counts one submit, and no estimate', async () => {
    const [submit, estimate] = [await refusals('submit'), await refusals('estimate')];
    expect(() =>
      assertNoBlockMediaInputs({ image: PATH }, { appBlockId: 'apb_1', phase: 'submit' })
    ).toThrow();
    expect(await refusals('submit')).toBe(submit + 1);
    expect(await refusals('estimate')).toBe(estimate);
  });

  it('CONTROL: an allowed body counts nothing', async () => {
    const before = await refusals('estimate');
    assertNoBlockMediaInputs(
      { image: 'https://example.com/a.png' },
      { appBlockId: 'apb_1', phase: 'estimate' }
    );
    expect(await refusals('estimate')).toBe(before);
  });
});
