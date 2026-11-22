import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildFeedGoBaseModels,
  FEED_GO_BASEMODELS_PATH,
  renderFeedGoBaseModels,
} from '../feed-go-basemodels';

// The Go model.getAll port reads its base-model facts from this committed file; a change to the
// constants or to the functions that decide from them must regenerate it, or the Go service answers
// `canGenerate` and the mature-restricted version filter differently from Node.
describe('apps/feed-go basemodels.json', () => {
  it('is what the Node functions answer today (regenerate: pnpm exec tsx scripts/feed-go-basemodels.ts)', () => {
    expect(readFileSync(FEED_GO_BASEMODELS_PATH, 'utf8')).toBe(renderFeedGoBaseModels());
  });

  // Positive control: the table is built from the functions, so a known answer must be in it. These
  // are facts the model feed depends on, pinned as literals.
  it('holds the answers the feed reads', () => {
    const table = buildFeedGoBaseModels();
    expect(table.modelTypes).toContain('Checkpoint');
    expect(table.generation['SDXL 1.0']).toEqual(expect.arrayContaining(['Checkpoint', 'LORA']));
    expect(table.matureRestrictedModels).toContain('sd 3.5');
    // isBaseModelGenerationDisabled's answers (getResourceCanGenerate); SD 3 is disabled today.
    expect(table.generationDisabled).toContain('SD 3');
    expect(table.generationDisabled).not.toContain('SDXL 1.0');
    expect(table.levels).toEqual({ minorContent: 3, sfw: 3, nsfw: 60, public: 1, all: 31 });
    expect(table.versionFlags).toEqual({
      generationDisabled: 2,
      partnerService: 32,
      partnerTrains: 64,
    });
  });
});
