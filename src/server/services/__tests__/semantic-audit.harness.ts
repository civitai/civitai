import { beforeEach, describe, expect, it, type Mock } from 'vitest';
import type { SemanticAuditEntry } from '~/server/services/semantic-search-audit.service';
import type { CandidateSource, GuardRead } from '~/server/services/semantic-search-client';
import type { SessionUser } from '~/types/session';

/** The keys a semantic search procedure may hand the browser, besides the router's latencyMs. */
const PAGE_KEYS = ['items', 'nextCursor', 'correctedQuery'];

export const AUDIT_VIEWER = { id: 77, isModerator: false } as SessionUser;

type Run = (args: {
  source: CandidateSource;
  user?: SessionUser;
  cursor?: number;
}) => Promise<{ items: { id: number }[] }>;

/**
 * The audit contract every semantic search service keeps, run against that service's own test
 * harness. `ids` must be ids the harness hydrates for AUDIT_VIEWER; `narrowToMinor` and `refuse`
 * set the harness's word audit to a minor verdict and to a refusal.
 */
export function describeSemanticAuditContract({
  index,
  run,
  ids,
  recorded,
  narrowToMinor,
  refuse,
}: {
  index: SemanticAuditEntry['index'];
  run: Run;
  ids: number[];
  recorded: Mock;
  narrowToMinor: () => void;
  refuse: () => void;
}) {
  const source =
    (guard: GuardRead & { refused?: boolean }, served = ids): CandidateSource =>
    async ({ offset, limit }) => ({ ids: served.slice(offset, offset + limit), guard });
  const shadowFlag: GuardRead = {
    outcome: 'flag',
    rules: ['block:rule_a'],
    mode: 'shadow',
    version: 'v1',
  };
  const enforceFlag = { ...shadowFlag, mode: 'enforce', refused: true };
  const entry = () => recorded.mock.calls.at(-1)?.[0] as SemanticAuditEntry | undefined;
  beforeEach(() => recorded.mockClear());

  describe(`${index}: the guard's verdict never reaches a non-moderator`, () => {
    it.each([
      ['shadow', source(shadowFlag)],
      ['enforce', source(enforceFlag, [])],
    ])('in %s mode, the response carries no guard, rule or verdict', async (_, src) => {
      const result = await run({ source: src, user: AUDIT_VIEWER });
      expect(Object.keys(result).filter((k) => !PAGE_KEYS.includes(k))).toEqual([]);
      expect(JSON.stringify(result)).not.toMatch(/rule_a|guard|bypass|verdict/i);
    });
  });

  describe(`${index}: one audit row per first-page search`, () => {
    it("records the viewer, the guard's verdict and what was served", async () => {
      const result = await run({ source: source(shadowFlag), user: AUDIT_VIEWER });
      expect(result.items.length).toBeGreaterThan(0);
      expect(recorded).toHaveBeenCalledTimes(1);
      expect(entry()).toMatchObject({
        index,
        viewer: { id: AUDIT_VIEWER.id, isModerator: false },
        wordVerdict: false,
        withholdIds: false,
        guard: { outcome: 'flag', rules: ['block:rule_a'], mode: 'shadow' },
        cacheHit: false,
        resultIds: result.items.map((x) => x.id),
      });
    });

    it('marks a narrowed minor search so its row keeps no ids', async () => {
      narrowToMinor();
      await run({ source: source(shadowFlag), user: AUDIT_VIEWER });
      expect(entry()).toMatchObject({ wordVerdict: 'minor', withholdIds: true });
    });

    it('records a refused search, with no guard verdict and nothing served', async () => {
      refuse();
      await run({ source: source(shadowFlag), user: AUDIT_VIEWER });
      expect(entry()?.wordVerdict).toBeTruthy();
      expect(entry()).toMatchObject({ guard: { outcome: 'none' }, resultIds: [] });
    });

    it('records nothing for a later page', async () => {
      await run({ source: source(shadowFlag), user: AUDIT_VIEWER, cursor: 1 });
      expect(recorded).not.toHaveBeenCalled();
    });
  });
}
