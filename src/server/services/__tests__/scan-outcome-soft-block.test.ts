import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  blockedNSFW,
  blockedNSFWOverridable,
  poiWords,
} from '@civitai/mod-utils/prompt-audit/lists';
import type * as Blocklist from '~/server/services/blocklist.service';
import type * as ImageService from '~/server/services/image.service';

vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof Blocklist>()),
  stripBenignPhrases: vi.fn(async (text: string) => text),
}));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  getImagesModRules: vi.fn(async () => []),
}));
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

import { resolveScanOutcome, type ScanImage } from '../image-scan-pipeline';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { auditImageMeta } from '~/utils/media-preprocessors/image.preprocessor';
import { auditPromptEnriched } from '~/utils/metadata/audit';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

/**
 * The scan of an NSFW-rated image and the post editor must reach the same verdict on the same
 * prompt; otherwise the scan blocks, after the fact, an image the editor let the user add. The
 * audit here is the real one; only storage and the tag read are stubbed.
 */

const overridable = new Set(blockedNSFWOverridable);
const pick = (soft: boolean) => {
  const word = blockedNSFW.find((w) => /^[a-z]+$/.test(w) && overridable.has(w) === soft);
  if (!word) throw new Error('no word to test with');
  return word;
};
const soft = pick(true);
const person = poiWords.find(
  (w) => /^[a-z ]+$/.test(w) && auditPromptEnriched(w).triggers[0]?.category === 'poi'
);
if (!person) throw new Error('no real-person name to test with');
const hard = pick(false);

const image = (prompt: string) =>
  ({
    id: 1,
    userId: 2,
    createdAt: new Date('2025-12-01T00:00:00.000Z'),
    scannedAt: new Date('2026-01-01T00:00:00.000Z'),
    type: 'image',
    meta: { prompt },
    metadata: {},
    postId: null,
    nsfwLevel: 0,
    nsfwLevelLocked: false,
    ingestion: 'Pending',
  } as unknown as ScanImage);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation((async (strings: TemplateStringsArray) => {
    const text = strings.join('');
    // An X-rated scan tag, so the prompt audit runs.
    if (text.includes('TagsOnImageDetails'))
      return [{ id: 10, name: 'tag', type: 'Label', nsfwLevel: 16, confidence: 90 }];
    if (text.includes('is_new_user')) return [{ isNewUser: false }];
    return [{ poi: false, minor: false, hasResource: false }];
  }) as never);
});

const scan = (prompt: string) =>
  resolveScanOutcome({ image: image(prompt), workflowId: 'wf', prompt });

describe('the scan of an NSFW image decides a prompt as the post editor does', () => {
  it.each([
    ['only overridable', soft, false],
    ['overridable beside hard', `${soft}, ${hard}`, true],
    ['hard alone', hard, true],
    ['overridable beside a minor age', `${soft}, a 10 year old`, true],
    ['overridable beside a real person', `${soft}, ${person}`, true],
  ])('%s', async (_, prompt, expectBlocked) => {
    const { blockedFor: editorBlocked } = await auditImageMeta({ prompt }, true);
    const outcome = await scan(prompt);

    expect(!!editorBlocked).toBe(expectBlocked);
    expect(outcome.ingestion === 'Blocked').toBe(expectBlocked);
  });

  it('records a let-through overridable match in Axiom', async () => {
    await scan(soft);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'image-prompt-soft-block-pass',
        details: { triggers: [{ category: 'nsfw_blocklist', matchedWord: soft }] },
      })
    );
  });
});
