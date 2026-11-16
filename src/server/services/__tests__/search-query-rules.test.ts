import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import promClient from 'prom-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BlocklistType } from '~/server/common/enums';
import type * as BlocklistService from '~/server/services/blocklist.service';

const h = vi.hoisted(() => ({ readBlocklistWithSource: vi.fn() }));
vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlocklistService>()),
  readBlocklistWithSource: h.readBlocklistWithSource,
  stripBenignPhrases: async (text: string) => text,
}));

import {
  createQueryRuleReader,
  parseFallbackRules,
  setQueryRuleReaderForTests,
  type QueryRuleReader,
  type QueryRuleType,
} from '~/server/services/search-query-rules';
import {
  dryRunSemanticQuery,
  queryVerdictLevel,
  recordRefusal,
  semanticQueryRefusal,
  type QueryTracker,
} from '~/server/services/semantic-query-guard';
import {
  allBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';

// Synthetic tokens: on no real list, so a match can only come from the rules under test.
const POI = 'zqvoxpoitoken';
const MINOR = 'zqvoxminortoken';
const POI_TYPE = BlocklistType.SemanticSearchPoiRefuse;
const MINOR_TYPE = BlocklistType.SemanticSearchMinorSafe;

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'query-rules-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('parseFallbackRules', () => {
  it('reads each type and skips blanks and comments', () => {
    const rules = parseFallbackRules(
      `# header\n\n${POI_TYPE} ${POI}\n${MINOR_TYPE}   two words  \n`
    );
    expect(rules.get(POI_TYPE)).toEqual([POI]);
    expect(rules.get(MINOR_TYPE)).toEqual(['two words']);
  });

  it.each([`Unknown ${POI}`, POI_TYPE])('throws on a malformed line (%s)', (line) => {
    expect(() => parseFallbackRules(line)).toThrow(/line 1/);
  });
});

describe('createQueryRuleReader', () => {
  beforeEach(() => {
    h.readBlocklistWithSource.mockReset();
  });

  it('reports the blocklist source when the blocklist answers', async () => {
    h.readBlocklistWithSource.mockResolvedValue({
      dto: { type: POI_TYPE, data: [POI] },
      source: 'cache',
    });
    const reader = createQueryRuleReader({ fallbackPath: join(dir, 'absent.txt') });
    expect(await reader.read(POI_TYPE)).toEqual({ terms: [POI], source: 'cache' });
  });

  it('reads the fallback file on every fallback, so an edit applies at the next read', async () => {
    h.readBlocklistWithSource.mockImplementation(async () => {
      throw new Error('db down');
    });
    const path = join(dir, 'rules.txt');
    const reader = createQueryRuleReader({ fallbackPath: path });

    await writeFile(path, `${POI_TYPE} ${POI}\n`);
    expect(await reader.read(POI_TYPE)).toEqual({ terms: [POI], source: 'fallback' });

    await writeFile(path, `${POI_TYPE} replaced\n`);
    expect(await reader.read(POI_TYPE)).toEqual({ terms: ['replaced'], source: 'fallback' });
    const flag = await promClient.register
      .getSingleMetric('semantic_search_query_rule_fallback')
      ?.get();
    expect(flag?.values.find((v) => v.labels.type === POI_TYPE)?.value).toBe(1);

    h.readBlocklistWithSource.mockResolvedValue({
      dto: { type: POI_TYPE, data: [POI] },
      source: 'db',
    });
    await reader.read(POI_TYPE);
    const recovered = await promClient.register
      .getSingleMetric('semantic_search_query_rule_fallback')
      ?.get();
    expect(recovered?.values.find((v) => v.labels.type === POI_TYPE)?.value).toBe(0);
  });

  it('serves a warm pod its last good copy during an outage, ahead of the file, past 5 minutes', async () => {
    const path = join(dir, 'older.txt');
    await writeFile(path, `${POI_TYPE} fromfile\n`);
    const reader = createQueryRuleReader({ fallbackPath: path });
    h.readBlocklistWithSource.mockResolvedValue({
      dto: { type: POI_TYPE, data: [POI] },
      source: 'db',
    });
    // The clock is pinned for both reads, so the copy's age is exactly 6 minutes.
    const t0 = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0);
    await reader.read(POI_TYPE);

    h.readBlocklistWithSource.mockImplementation(async () => {
      throw new Error('db down');
    });
    now.mockReturnValue(t0 + 6 * 60_000);
    try {
      expect(await reader.read(POI_TYPE)).toEqual({ terms: [POI], source: 'stale' });
      const gauge = await promClient.register
        .getSingleMetric('semantic_search_query_rule_stale_seconds')
        ?.get();
      const age = gauge?.values.find((v) => v.labels.type === POI_TYPE)?.value ?? 0;
      expect(age).toBe(360);
    } finally {
      vi.mocked(Date.now).mockRestore();
    }
  });

  it('refuses on a cold pod during an outage with no file', async () => {
    h.readBlocklistWithSource.mockImplementation(async () => {
      throw new Error('db down');
    });
    setQueryRuleReaderForTests(createQueryRuleReader({ fallbackPath: join(dir, 'absent.txt') }));
    expect(await refusal('a red bicycle', false)).toBe('error');
  });

  it('throws when neither the blocklist nor the file can be read', async () => {
    h.readBlocklistWithSource.mockImplementation(async () => {
      throw new Error('db down');
    });
    const reader = createQueryRuleReader({ fallbackPath: join(dir, 'absent.txt') });
    await expect(reader.read(POI_TYPE)).rejects.toThrow();
  });
});

function stubReader(rules: Partial<Record<QueryRuleType, string[]>>): QueryRuleReader {
  return { read: async (type) => ({ terms: rules[type] ?? [], source: 'db' }) };
}
const refusal = (query: string, isModerator: boolean) =>
  semanticQueryRefusal(query, {
    browsingLevel: allBrowsingLevelsFlag,
    disablePoi: false,
    isModerator,
  });

describe('semanticQueryRefusal with query rules', () => {
  beforeEach(() =>
    setQueryRuleReaderForTests(stubReader({ [POI_TYPE]: [POI], [MINOR_TYPE]: [MINOR] }))
  );

  it('passes a query that matches no rule', async () => {
    expect(await refusal('a red bicycle', false)).toBe(false);
  });

  it('refuses a POI addition for non-moderators and exempts moderators', async () => {
    expect(await refusal(`photo of ${POI}`, false)).toBe('poi');
    expect(await refusal(`photo of ${POI}`, true)).toBe(false);
  });

  it('narrows a non-moderator on a minor addition and refuses a moderator', async () => {
    const nonMod = await refusal(`a ${MINOR} portrait`, false);
    const mod = await refusal(`a ${MINOR} portrait`, true);
    expect(nonMod).toBe('minor-safe');
    expect(mod).toBe('minor-safe');
    expect(queryVerdictLevel(nonMod, allBrowsingLevelsFlag, false)).toBe(
      allBrowsingLevelsFlag & sfwBrowsingLevelsFlag
    );
    expect(queryVerdictLevel(mod, allBrowsingLevelsFlag, true)).toBe('refuse');
  });

  it('matches terms literally, so one malformed entry cannot break the others', async () => {
    setQueryRuleReaderForTests(
      stubReader({ [POI_TYPE]: ['(unclosed', 'zq.vox', 'zqa|zqb', POI], [MINOR_TYPE]: ['[x'] })
    );
    expect(await refusal(`photo of ${POI}`, false)).toBe('poi');
    expect(await refusal('zqXvox', false)).toBe(false);
    expect(await refusal('zqa', false)).toBe(false);
    expect(await refusal('a red bicycle', false)).toBe(false);
  });

  it('matches a moderator term with punctuation and metacharacters as typed', async () => {
    setQueryRuleReaderForTests(
      stubReader({ [POI_TYPE]: ["zq-vox o'poi"], [MINOR_TYPE]: ['zq.min(r)'] })
    );
    expect(await refusal("photo of zq-vox o'poi", false)).toBe('poi');
    expect(await refusal('a zq.min(r) portrait', false)).toBe('minor-safe');
  });

  it('ignores a POI term that matching strips to nothing, instead of refusing everything', async () => {
    setQueryRuleReaderForTests(stubReader({ [POI_TYPE]: ['日本語', '  ', POI] }));
    expect(await refusal('cat, dog', false)).toBe(false);
    expect(await refusal('日本語の写真', false)).toBe(false);
    expect(await refusal(`photo of ${POI}`, false)).toBe('poi');
  });

  it('fails closed when the rules cannot be read', async () => {
    setQueryRuleReaderForTests({ read: () => Promise.reject(new Error('no copy')) });
    expect(await refusal('a red bicycle', false)).toBe('error');
  });
});

describe('recordRefusal', () => {
  beforeEach(() => {
    setQueryRuleReaderForTests(stubReader({ [MINOR_TYPE]: [MINOR] }));
  });

  it('fires no help event for a minor-addition match, and still fires one for the minor list', async () => {
    const track: QueryTracker = { action: vi.fn<QueryTracker['action']>(async () => true) };
    const verdict = await refusal(`a ${MINOR} portrait`, false);
    recordRefusal(track, verdict, `a ${MINOR} portrait`, 'test_index');
    expect(track.action).not.toHaveBeenCalled();

    recordRefusal(track, 'minor', 'q', 'test_index');
    expect(track.action).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'CSAM_Help_Triggered' })
    );
  });
});

describe('dryRunSemanticQuery', () => {
  beforeEach(() =>
    setQueryRuleReaderForTests(stubReader({ [POI_TYPE]: [POI], [MINOR_TYPE]: [MINOR] }))
  );

  it('returns the verdict for each viewer and never the matched term', async () => {
    const result = await dryRunSemanticQuery(`${POI} and ${MINOR}`);
    expect(result).toEqual({
      nonModerator: { verdict: 'poi', result: 'refuse' },
      moderator: { verdict: 'minor-safe', result: 'refuse' },
    });
    expect(JSON.stringify(result)).not.toContain(POI);
    expect(JSON.stringify(result)).not.toContain(MINOR);
  });

  it('reports a narrowed non-moderator and an allowed query', async () => {
    expect((await dryRunSemanticQuery(`a ${MINOR}`)).nonModerator).toEqual({
      verdict: 'minor-safe',
      result: 'narrow',
    });
    expect(await dryRunSemanticQuery('a red bicycle')).toEqual({
      nonModerator: { verdict: false, result: 'allow' },
      moderator: { verdict: false, result: 'allow' },
    });
  });
});
