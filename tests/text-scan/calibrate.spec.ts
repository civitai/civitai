import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { NsfwLevel } from '../../src/server/common/enums';
import { apiFor } from './auth';
import { createArticle, createCommentV2, createModel } from './drivers';
import { fixture, withNonce, type FixtureKey } from './fixtures';
import { harness } from './ops';
import { createUser } from './users';

type ScanEntityResult =
  | {
      ok: true;
      workflowId: string;
      promptIds: Record<string, number>;
      parse: { ok: boolean };
      outcome: { triggeredLabels: string[]; nsfwLevel: number | null } | null;
    }
  | { ok: false; error: string };
type Verdict = Extract<ScanEntityResult, { ok: true }> & {
  outcome: NonNullable<Extract<ScanEntityResult, { ok: true }>['outcome']>;
};

const RUNS = 3;
// Verdicts describe classifier behaviour, so they stay under the gitignored local/ directory.
const RECORD_DIR = path.resolve('tests/text-scan/local/calibration');

function record(name: string, verdicts: Verdict[]) {
  fs.mkdirSync(RECORD_DIR, { recursive: true });
  const file = path.join(RECORD_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);
  const lines = verdicts.map((v) =>
    JSON.stringify({
      test: name,
      at: new Date().toISOString(),
      workflowId: v.workflowId,
      promptIds: v.promptIds,
      triggeredLabels: v.outcome.triggeredLabels,
      nsfwLevel: v.outcome.nsfwLevel,
    })
  );
  fs.appendFileSync(file, `${lines.join('\n')}\n`);
}

async function verdicts(name: string, entityType: string, make: () => Promise<number>) {
  const out: Verdict[] = [];
  for (let i = 0; i < RUNS; i++) {
    const entityId = await make();
    const r = await harness<ScanEntityResult>({ action: 'scanEntity', entityType, entityId });
    if (!r.ok) throw new Error(`scanEntity ${entityType}/${entityId}: ${r.error}`);
    expect(r.parse.ok, `${entityType}/${entityId} parse`).toBe(true);
    out.push(r as Verdict);
  }
  record(name, out);
  return out;
}

test.describe('fixture calibration', () => {
  for (const [key, expectNsfw] of [
    ['sfw', false],
    ['explicit', true],
  ] as [FixtureKey, boolean][]) {
    test(`Article nsfw: ${key}`, { tag: '@calibrate' }, async () => {
      const owner = await createUser();
      const api = await apiFor(owner.id);
      const results = await verdicts(`Article nsfw: ${key}`, 'Article', () =>
        createArticle(api, withNonce(fixture(key)))
      );
      for (const r of results) {
        expect(r.outcome.triggeredLabels.includes('nsfw')).toBe(expectNsfw);
        if (expectNsfw) expect(r.outcome.nsfwLevel).toBeGreaterThanOrEqual(NsfwLevel.X);
      }
      await api.dispose();
    });
  }

  test('CommentV2 scam', { tag: '@calibrate' }, async () => {
    const author = await createUser();
    const api = await apiFor(author.id);
    const hostApi = await apiFor((await createUser()).id);
    const host = await createArticle(hostApi, withNonce(fixture('sfw')));
    const on = { entityType: 'article' as const, entityId: host };
    const scam = await verdicts('CommentV2 scam', 'CommentV2', () =>
      createCommentV2(api, on, withNonce(fixture('scam')))
    );
    const clean = await verdicts('CommentV2 clean', 'CommentV2', () =>
      createCommentV2(api, on, withNonce(fixture('sfw')))
    );
    for (const r of scam) expect(r.outcome.triggeredLabels).toContain('scam');
    for (const r of clean) expect(r.outcome.triggeredLabels).not.toContain('scam');
    await Promise.all([api.dispose(), hostApi.dispose()]);
  });

  for (const label of ['poi', 'minor'] as const) {
    test(`Model ${label}`, { tag: '@calibrate' }, async () => {
      const owner = await createUser();
      const api = await apiFor(owner.id);
      const results = await verdicts(`Model ${label}`, 'Model', () =>
        createModel(api, withNonce(fixture(label)))
      );
      for (const r of results) expect(r.outcome.triggeredLabels).toContain(label);
      await api.dispose();
    });
  }
});
