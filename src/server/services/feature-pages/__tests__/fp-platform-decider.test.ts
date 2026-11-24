import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/logging.mock';
import { deciding, platform, urnOf } from '~/server/services/feature-pages/__tests__/fp-harness';

vi.mock('~/server/db/kyselyDb', () => ({ kyselyRead: {}, kyselyWrite: {} }));

type Vector = {
  steps: {
    source: 'site' | 'pipeline' | 'moderator';
    outcome: string;
    token: string;
    at: string;
  }[];
  expected: { source: string; verdict: string } | null;
  site_lifts_mod: { source: string; verdict: string } | null;
  mod_per_digest: { source: string; verdict: string } | null;
};
// Every reachable sequence of up to three verdicts, answered by the platform's own decider.
const vectors: Vector[] = JSON.parse(
  gunzipSync(
    readFileSync(new URL('./fixtures/fp-verdict-vectors.json.gz', import.meta.url))
  ).toString()
);
const PATH = {
  site: '/internal/verdict/site',
  pipeline: '/internal/verdict',
  moderator: '/internal/verdict/mod',
} as const;

describe("the fake platform decides as the platform's decider does", () => {
  it('agrees on every vector, deciding source included', () => {
    platform.versions.set(1, 1);
    platform.tokenSite.clear();
    const disagree = vectors.filter((v) => {
      platform.verdicts = v.steps.map((s) => ({
        path: PATH[s.source],
        body: {
          target: { urn: urnOf(1), digest: s.token === 'current' ? 'sha256:1:1' : 'sha256:1:0' },
          verdict: s.outcome,
          at: s.at,
        },
      }));
      return JSON.stringify(deciding(1)) !== JSON.stringify(v.expected);
    });
    expect(vectors.length).toBeGreaterThan(4000);
    expect(disagree.slice(0, 3)).toEqual([]);
  });
});
