import { describe, it, expect } from 'vitest';

// Which votes a final-ratings batch settles, checked by evaluating the settle's vote-selection SQL
// over fixture rows rather than by its spelling. The evaluator understands only the clause shapes
// the SQL uses today and throws on anything else, so a rewrite fails loudly instead of passing.
// ClickHouse DateTime columns hold whole seconds: vote times come from the app clock, the
// decision's update_time from ClickHouse now().

import { NewOrderImageRatingStatus as S } from '~/server/common/enums';
import { PENDING_VOTES_CTE, PENDING_VOTES_JOIN } from '~/server/games/new-order/final-ratings-sql';

type Vote = { userId: string; imageId: number; status: string; rank: string; at: string };
type Decision = { imageId: number; at: string };

const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const toSecond = (iso: string) => Math.floor(Date.parse(iso) / 1000);

function settledVoters(votes: Vote[], decisions: Decision[]): string[] {
  const cte = norm(PENDING_VOTES_CTE);
  const m = cte.match(
    /^pending AS \( SELECT (.+) FROM knights_new_order_image_rating WHERE imageId IN \(SELECT imageId FROM batch\) GROUP BY userId, imageId HAVING (.+) \)$/
  );
  if (!m) throw new Error(`unexpected pending CTE shape: ${cte}`);
  const [, selectList, having] = m;

  const batch = new Map(decisions.map((d) => [d.imageId, toSecond(d.at)]));
  const groups = new Map<string, Vote[]>();
  for (const v of votes.filter((v) => batch.has(v.imageId))) {
    const key = `${v.userId}:${v.imageId}`;
    groups.set(key, [...(groups.get(key) ?? []), v]);
  }

  const aggregate = (rows: Vote[]) => {
    const latest = rows.reduce((a, b) => (toSecond(b.at) >= toSecond(a.at) ? b : a));
    const out: Record<string, unknown> = {};
    for (const item of selectList.split(/, (?![^(]*\))/)) {
      const arg = item.match(/^argMax\((\w+), createdAt\) AS (\w+)$/);
      const max = item.match(/^max\(createdAt\) AS (\w+)$/);
      if (item === 'userId' || item === 'imageId') out[item] = latest[item];
      else if (arg)
        out[arg[2]] =
          arg[1] === 'status' ? latest.status : arg[1] === 'rank' ? latest.rank : arg[1];
      else if (max) out[max[1]] = Math.max(...rows.map((r) => toSecond(r.at)));
      else throw new Error(`unknown select item: ${item}`);
    }
    return out;
  };

  const passesHaving = (row: Record<string, unknown>) =>
    having.split(' AND ').every((cond) => {
      const c = cond.match(/^(\w+) (=|!=) '([^']*)'$/);
      if (!c) throw new Error(`unknown HAVING condition: ${cond}`);
      return c[2] === '=' ? row[c[1]] === c[3] : row[c[1]] !== c[3];
    });

  const join = norm(PENDING_VOTES_JOIN);
  const j = join.match(
    /^FROM pending orig JOIN batch new ON new\.imageId = orig\.imageId(?: WHERE orig\.(\w+) <= new\.createdAt(?: \+ INTERVAL (\d+) SECOND)?)?$/
  );
  if (!j) throw new Error(`unexpected join shape: ${join}`);
  const [, column, margin = '0'] = j;

  return [...groups.values()]
    .map(aggregate)
    .filter(passesHaving)
    .filter(
      (row) =>
        !column || (row[column] as number) <= batch.get(row.imageId as number)! + Number(margin)
    )
    .map((row) => row.userId as string)
    .sort();
}

const IMAGE = 1;
const DECIDED = '2026-11-02T10:00:00.500Z';
const vote = (userId: string, status: string, at: string, rank = 'Knight', imageId = IMAGE) => ({
  userId,
  imageId,
  status,
  rank,
  at,
});

describe('which votes a final-ratings batch settles', () => {
  it('settles a vote still Pending, including one cast 1 ms before the decision in the same second', () => {
    expect(
      settledVoters(
        [
          vote('a', S.Pending, '2026-11-02T09:58:00.000Z'),
          vote('b', S.Pending, '2026-11-02T10:00:00.499Z'),
        ],
        [{ imageId: IMAGE, at: DECIDED }]
      )
    ).toEqual(['a', 'b']);
  });

  it('leaves votes whose latest status is already settled', () => {
    expect(
      settledVoters(
        [
          vote('c', S.Pending, '2026-11-02T09:50:00.000Z'),
          vote('c', S.Correct, '2026-11-02T09:51:00.000Z'),
          vote('d', S.Failed, '2026-11-02T09:52:00.000Z'),
          vote('e', S.Inconclusive, '2026-11-02T09:53:00.000Z'),
          vote('p', S.Pending, '2026-11-02T09:54:00.000Z'),
        ],
        [{ imageId: IMAGE, at: DECIDED }]
      )
    ).toEqual(['p']);
  });

  it('leaves a vote from a round that started after the decision', () => {
    expect(
      settledVoters(
        [
          vote('later', S.Pending, '2026-11-02T10:05:00.000Z'),
          vote('p', S.Pending, '2026-11-02T09:59:00.000Z'),
        ],
        [{ imageId: IMAGE, at: DECIDED }]
      )
    ).toEqual(['p']);
  });

  it('settles a vote a pod clock running a little ahead stamped just after the decision', () => {
    expect(
      settledVoters(
        [vote('ahead', S.Pending, '2026-11-02T10:00:02.000Z')],
        [{ imageId: IMAGE, at: DECIDED }]
      )
    ).toEqual(['ahead']);
  });

  it('leaves Acolyte votes and images outside the batch', () => {
    expect(
      settledVoters(
        [
          vote('acolyte', S.Pending, '2026-11-02T09:59:00.000Z', 'Acolyte'),
          vote('other', S.Pending, '2026-11-02T09:59:00.000Z', 'Knight', 2),
          vote('p', S.Pending, '2026-11-02T09:59:00.000Z'),
        ],
        [{ imageId: IMAGE, at: DECIDED }]
      )
    ).toEqual(['p']);
  });
});
