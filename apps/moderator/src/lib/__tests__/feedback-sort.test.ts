import { describe, expect, it } from 'vitest';
import { clearPaging } from '$lib/paging';
import {
  FEEDBACK_CURSOR_VALUE_PARAM,
  FEEDBACK_SORT_COLUMNS,
  feedbackNextPageHref,
  feedbackSortAria,
  feedbackSortHref,
  feedbackSortMarker,
  nextFeedbackSort,
  parseFeedbackSort,
  type FeedbackSort,
} from '$lib/feedback-sort';

/**
 * The URL half of the feedback queue's column sort.
 *
 * Both params are typed by whoever is holding the keyboard and the column ends up naming a SQL
 * identifier, so the cases that matter here are the hostile ones. The ORDERING itself is a statement
 * about rows and is tested where rows exist — `lib/server/__tests__/feedback-sort.pglite.test.ts`.
 */

const url = (search: string) => new URL(`https://moderator.test/feedback${search}`);
const params = (search: string) => url(search).searchParams;

describe('parseFeedbackSort', () => {
  it('reads a known column and direction', () => {
    expect(parseFeedbackSort(params('?sort=area&dir=desc'))).toEqual({
      column: 'area',
      direction: 'desc',
    });
  });

  it('reads every column the table offers', () => {
    for (const column of FEEDBACK_SORT_COLUMNS)
      expect(parseFeedbackSort(params(`?sort=${column}&dir=asc`))).toEqual({
        column,
        direction: 'asc',
      });
    // The instrument: a list that had gone empty would make the loop vacuous.
    expect(FEEDBACK_SORT_COLUMNS.length).toBe(6);
  });

  it('is the default ordering when no sort is named', () => {
    expect(parseFeedbackSort(params(''))).toBeNull();
    expect(parseFeedbackSort(params('?status=new&area=apps-marketplace'))).toBeNull();
  });

  /**
   * 🔴 THE ALLOWLIST. The column names a SQL identifier downstream, so anything not on the list has
   * to be refused here rather than passed along — including the shapes that would matter if it ever
   * reached a query builder as text.
   *
   * `attachments` is on this list on purpose: it is the ONE header a reader would expect to be
   * sortable and is deliberately not (the count is derived from JSONB — see `feedback-sort.ts`), so
   * a future edit that adds the key to the union without the SQL half fails here.
   */
  it('refuses a column that is not on the list, rather than passing it through', () => {
    for (const hostile of [
      'attachments',
      'createdAt',
      'f.id',
      'id; drop table "Feedback"',
      "id' or '1'='1",
      'AGE',
      'age ',
      '',
      '__proto__',
      'constructor',
      'toString',
    ])
      expect(
        parseFeedbackSort(params(`?sort=${encodeURIComponent(hostile)}&dir=asc`)),
        `"${hostile}" was accepted as a sort column`
      ).toBeNull();
  });

  /**
   * A direction is the SECOND untrusted input, and it degrades differently: an unknown one leaves a
   * KNOWN column sorted ascending — the first state of the cycle, which is what a hand-written
   * `?sort=area` should mean — rather than dropping a sort the operator did ask for.
   */
  it('degrades an unknown direction on a known column to ascending', () => {
    for (const hostile of ['sideways', 'DESC', 'desc ', '1', '', 'asc; --', '__proto__'])
      expect(
        parseFeedbackSort(params(`?sort=status&dir=${encodeURIComponent(hostile)}`)),
        `"${hostile}" was accepted as a direction`
      ).toEqual({ column: 'status', direction: 'asc' });

    expect(parseFeedbackSort(params('?sort=status'))).toEqual({
      column: 'status',
      direction: 'asc',
    });
  });

  /** A direction with no column is not half a sort — it is no sort. */
  it('ignores a direction that names no column', () => {
    expect(parseFeedbackSort(params('?dir=desc'))).toBeNull();
  });
});

describe('the tri-state cycle', () => {
  /**
   * 🔴 THE FULL LOOP, WALKED. Asserting the three transitions separately lets a mutant that makes
   * `desc` cycle back to `asc` pass two of them; only walking the loop and landing back where it
   * started pins that "none" is reachable at all.
   */
  it('goes ascending → descending → none → ascending on one column', () => {
    const first = nextFeedbackSort(null, 'status');
    expect(first).toEqual({ column: 'status', direction: 'asc' });

    const second = nextFeedbackSort(first, 'status');
    expect(second).toEqual({ column: 'status', direction: 'desc' });

    const third = nextFeedbackSort(second, 'status');
    expect(third).toBeNull();

    expect(nextFeedbackSort(third, 'status')).toEqual({ column: 'status', direction: 'asc' });
  });

  /**
   * Clicking a different column starts THAT column at ascending. The fixture deliberately carries a
   * `desc` on a different column: a mutant that keeps the previous direction survives a fixture
   * whose current direction is already `asc`.
   */
  it('starts a different column at ascending rather than inheriting the direction', () => {
    const current: FeedbackSort = { column: 'area', direction: 'desc' };
    expect(nextFeedbackSort(current, 'issue')).toEqual({ column: 'issue', direction: 'asc' });
  });

  it('reports the active column to assistive tech and leaves the others sortable-but-unsorted', () => {
    const current: FeedbackSort = { column: 'user', direction: 'desc' };
    expect(feedbackSortAria(current, 'user')).toBe('descending');
    expect(feedbackSortAria({ column: 'user', direction: 'asc' }, 'user')).toBe('ascending');
    expect(feedbackSortAria(current, 'area')).toBe('none');
    expect(feedbackSortAria(null, 'user')).toBe('none');
  });

  it('marks only the active column', () => {
    expect(feedbackSortMarker({ column: 'user', direction: 'asc' }, 'user')).toBe('↑');
    expect(feedbackSortMarker({ column: 'user', direction: 'desc' }, 'user')).toBe('↓');
    expect(feedbackSortMarker({ column: 'user', direction: 'desc' }, 'status')).toBe('');
    expect(feedbackSortMarker(null, 'status')).toBe('');
  });
});

describe('clearPaging', () => {
  /**
   * 🔴 BOTH HALVES, AND FROM THE SHARED HELPER RATHER THAN A PAGE-LOCAL WRAPPER. A value half
   * surviving a new batch is not a harmless leftover — it is the operand of the keyset comparison,
   * so the "first" page of the new query starts in the middle of the old one. A wrapper that added
   * the delete would be a SECOND door onto this rule: ten files in this app reach for `clearPaging`,
   * and the next control added here would reach for it too.
   *
   * Asserted from `$lib/feedback-sort`'s point of view because this page is the only writer of the
   * param today — if the delete is ever moved back out of `clearPaging`, this is what goes red.
   */
  it('drops both halves of the compound cursor and the numbered-paging params', () => {
    const p = params('?status=new&cursor=91&cursorValue=zeta&cursors=91,77&imgPage=3&open=4');
    clearPaging(p);

    expect(p.get('cursor')).toBeNull();
    expect(p.get(FEEDBACK_CURSOR_VALUE_PARAM)).toBeNull();
    expect(p.get('cursors')).toBeNull();
    expect(p.get('imgPage')).toBeNull();
    // Not paging state: the filters and the open row describe the view, not a position in it.
    expect(p.get('status')).toBe('new');
    expect(p.get('open')).toBe('4');
  });
});

describe('feedbackNextPageHref', () => {
  /**
   * 🔴 THE VALUE HALF IS REWRITTEN ON EVERY TURN, INCLUDING WHEN THERE IS NOTHING TO WRITE. The
   * current URL already carries the PREVIOUS page's value, so a builder that only writes when the
   * new one is non-null ships the old boundary attached to the new cursor id.
   *
   * That is not a hand-edited-URL case, it is the ordinary transition INTO the trailing null block —
   * `handled` is null on every untriaged row. The server then reads a non-null boundary, whose
   * predicate admits the entire null block with no id bound, so the same page comes back with its
   * own boundary row in it and `Next →` never advances.
   */
  it('DELETES the value half when the new boundary has none, rather than leaving the old one', () => {
    const href = feedbackNextPageHref(
      url('?sort=handled&dir=asc&cursor=91&cursorValue=mira'),
      77,
      null
    );
    const next = new URL(href, 'https://moderator.test');

    expect(next.searchParams.get('cursor')).toBe('77');
    expect(next.searchParams.get(FEEDBACK_CURSOR_VALUE_PARAM)).toBeNull();
    expect(next.searchParams.get('sort')).toBe('handled');
    expect(next.searchParams.get('dir')).toBe('asc');
  });

  it('carries both halves when there is a value, and closes the open row', () => {
    const href = feedbackNextPageHref(
      url('?sort=handled&dir=asc&cursor=91&cursorValue=mira&open=4'),
      77,
      'quinn'
    );
    const next = new URL(href, 'https://moderator.test');

    expect(next.searchParams.get('cursor')).toBe('77');
    expect(next.searchParams.get(FEEDBACK_CURSOR_VALUE_PARAM)).toBe('quinn');
    // `?open=` can name a row this page does not contain — the same rule `FeedbackFilters` applies.
    expect(next.searchParams.get('open')).toBeNull();
  });

  /**
   * 🔴 AN EMPTY STRING IS A VALUE, AND ABSENCE MEANS NULL — so the two must not collapse. `urlWith`
   * deletes on `''` as well as on `null`, which is why this builder writes the param with
   * `searchParams.set` instead. Collapsed, every row past an empty-string boundary is unreachable:
   * the server looks for the null block, finds nothing, and reports no next page.
   */
  it('keeps an empty-string boundary distinct from an absent one', () => {
    const withEmpty = new URL(
      feedbackNextPageHref(url('?sort=area&dir=asc&cursor=91'), 77, ''),
      'https://moderator.test'
    );
    expect(withEmpty.searchParams.has(FEEDBACK_CURSOR_VALUE_PARAM)).toBe(true);
    expect(withEmpty.searchParams.get(FEEDBACK_CURSOR_VALUE_PARAM)).toBe('');

    const withNull = new URL(
      feedbackNextPageHref(url('?sort=area&dir=asc&cursor=91'), 77, null),
      'https://moderator.test'
    );
    expect(withNull.searchParams.has(FEEDBACK_CURSOR_VALUE_PARAM)).toBe(false);
  });

  /** The unsorted queue pages exactly as it did before: an id, and no value half at all. */
  it('writes no value half for the default ordering', () => {
    expect(feedbackNextPageHref(url('?status=new'), 77, null)).toBe(
      '/feedback?status=new&cursor=77'
    );
  });
});

describe('feedbackSortHref', () => {
  /**
   * 🔴 A CURSOR FROM ONE ORDERING IS MEANINGLESS IN ANOTHER. Carried across a sort change it names a
   * row that is no longer the boundary, so the page that comes back is neither the first nor the
   * next one — it is arbitrary rows that look exactly like data.
   *
   * The fixture's cursor (91), value ("zeta") and open row (4) are pairwise distinct and distinct
   * from every constant this file asserts, so a mutant that clears the wrong param cannot be masked
   * by two of them happening to agree.
   */
  it('clears both halves of the cursor and keeps the filters and the open row', () => {
    const href = feedbackSortHref(
      url('?status=new&area=apps-marketplace&cursor=91&cursorValue=zeta&open=4'),
      'area'
    );
    const next = new URL(href, 'https://moderator.test');

    expect(next.searchParams.get('cursor')).toBeNull();
    expect(next.searchParams.get(FEEDBACK_CURSOR_VALUE_PARAM)).toBeNull();
    expect(next.searchParams.get('status')).toBe('new');
    expect(next.searchParams.get('area')).toBe('apps-marketplace');
    expect(next.searchParams.get('open')).toBe('4');
    expect(next.searchParams.get('sort')).toBe('area');
    expect(next.searchParams.get('dir')).toBe('asc');
  });

  /**
   * 🔴 IT MUST NEVER SET `?open=`. `feedbackOpenHref` is the single choke point for that param — it
   * is the only thing that also deletes `?tab=`, and a second writer reopens the sticky-tab bug
   * whose repro sits in that helper's docstring. Re-sorting does not change WHICH reports are in the
   * view, so the row the operator is reading stays exactly as it was: same value in, same value out.
   */
  it('leaves the open row untouched in both directions and on the way back to none', () => {
    let current = url('?open=4');
    for (const expected of ['asc', 'desc', null]) {
      current = new URL(feedbackSortHref(current, 'handled'), 'https://moderator.test');
      expect(current.searchParams.get('open')).toBe('4');
      expect(current.searchParams.get('dir')).toBe(expected);
    }
  });

  it('walks the cycle in the URL, and the third click leaves no sort params behind', () => {
    const first = feedbackSortHref(url('?status=new'), 'issue');
    expect(first).toBe('/feedback?status=new&sort=issue&dir=asc');

    const second = feedbackSortHref(url(new URL(first, 'https://x.test').search), 'issue');
    expect(second).toBe('/feedback?status=new&sort=issue&dir=desc');

    const third = feedbackSortHref(url(new URL(second, 'https://x.test').search), 'issue');
    expect(third).toBe('/feedback?status=new');
  });

  it('switches columns rather than stacking them', () => {
    const href = feedbackSortHref(url('?sort=area&dir=desc'), 'status');
    const next = new URL(href, 'https://moderator.test');

    expect(next.searchParams.getAll('sort')).toEqual(['status']);
    expect(next.searchParams.getAll('dir')).toEqual(['asc']);
  });

  /**
   * A hostile `?sort=` in the CURRENT url is the default ordering — the same reading the server
   * takes — so the next click is the FIRST click, on `asc`. Without this the header strip would
   * cycle against a state nothing else on the page agrees with: the rows would be in default order
   * while the arrow claimed `desc`.
   *
   * `dir=desc` is in the fixture on purpose. If the hostile column were read as active, the cycle
   * would answer `null` here instead of `asc`, so the two outcomes are distinguishable.
   */
  it('treats an unparseable current sort as no sort', () => {
    const href = feedbackSortHref(url('?sort=attachments&dir=desc'), 'area');
    expect(new URL(href, 'https://moderator.test').search).toBe('?sort=area&dir=asc');
  });
});
