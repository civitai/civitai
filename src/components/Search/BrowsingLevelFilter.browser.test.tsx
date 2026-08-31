import type { ReactElement } from 'react';
import { describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { InstantSearch, useHits } from 'react-instantsearch';
import type { InstantSearchProps } from 'react-instantsearch';
import { renderWithProviders } from '../../../test/component-setup';
import { BrowsingLevelFilter } from '~/components/Search/CustomSearchComponents';

/**
 * What this proves: our component asks the engine for the right thing, and the UI renders only
 * what comes back. What it does NOT prove: that Meilisearch honours the filter — that half is
 * verified by hand against the real engine.
 *
 * The sibling suites assert the emitted filter string and that each index declares the attribute
 * it is filtered on. Neither can catch a fail-open, because "results came back" is exactly the
 * assertion that still passes when the filter is dropped. So this one asserts ABSENCE: the fixture
 * carries documents above the selected browsing level, and they must not reach the rendered list.
 */

type FixtureDoc = {
  objectID: string;
  name: string;
  nsfwLevel: number;
  type: string;
};

const PG = 1;
const PG13 = 2;
const R = 4;
const X = 8;
const XXX = 16;

const FIXTURE: FixtureDoc[] = [
  { objectID: 'pg-checkpoint', name: 'Sunny Landscapes', nsfwLevel: PG, type: 'Checkpoint' },
  { objectID: 'pg-lora', name: 'Soft Light Detailer', nsfwLevel: PG, type: 'LORA' },
  { objectID: 'pg13-checkpoint', name: 'Beach Day', nsfwLevel: PG13, type: 'Checkpoint' },
  { objectID: 'r-checkpoint', name: 'Late Night', nsfwLevel: R, type: 'Checkpoint' },
  { objectID: 'x-lora', name: 'Explicit Study', nsfwLevel: X, type: 'LORA' },
  { objectID: 'xxx-lora', name: 'Hardcore Mix', nsfwLevel: XXX, type: 'LORA' },
];

// No BrowsingLevelProvider in the harness, so `useBrowsingLevelDebounced` resolves through the
// context default — `publicBrowsingLevelsFlag`, i.e. PG alone. Everything else is above it.
const IN_LEVEL = ['hit-pg-checkpoint', 'hit-pg-lora'];
const ABOVE_LEVEL = ['hit-pg13-checkpoint', 'hit-r-checkpoint', 'hit-x-lora', 'hit-xxx-lora'];

const PARENTHESISED_CLAUSE = /^\(([^()]*)\)$/;

/**
 * Scoped to the exact expression `joinFilterClauses` emits — parenthesised clauses ANDed together,
 * each an `attr=N OR attr=M` chain — and deliberately not a Meilisearch filter parser. Anything
 * else throws rather than being skipped: a clause shape the fake silently ignored would let a
 * document through and read as a passing test.
 */
function matchesClause(doc: FixtureDoc, clause: string) {
  return clause.split(' OR ').some((term) => {
    const [attribute, value, ...rest] = term.split('=');
    if (value === undefined || rest.length > 0) {
      throw new Error(`fake search client cannot evaluate the term "${term}"`);
    }

    return String(doc[attribute as keyof FixtureDoc]) === value;
  });
}

function matchesFilter(doc: FixtureDoc, filter: string) {
  if (!filter) return true;

  return filter.split(' AND ').every((clause) => {
    const parenthesised = PARENTHESISED_CLAUSE.exec(clause);
    if (!parenthesised) {
      throw new Error(`fake search client cannot evaluate the clause "${clause}" of "${filter}"`);
    }

    return matchesClause(doc, parenthesised[1]);
  });
}

// A refine loop would otherwise spin unbounded while the DOM assertions still pass. Bounded and
// asserted, it fails on a number instead of running until the job is killed.
const MAX_SEARCHES = 20;

type FakeQuery = { params?: { query?: string; filters?: string } };

/**
 * 🔴 The fake APPLIES the filter it is handed. Do not "simplify" it into one that returns the
 * fixture as-is — that is the fail-open this file exists to catch, and it would pass. One that
 * returns a pre-filtered list is the same defect wearing a green tick.
 */
function createFakeSearchClient(docs: FixtureDoc[] = FIXTURE) {
  const filtersSeen: string[] = [];

  const searchClient = {
    search(queries: readonly FakeQuery[]) {
      return Promise.resolve({
        results: queries.map((query) => {
          const filters = query.params?.filters ?? '';
          filtersSeen.push(filters);

          const hits = docs.filter((doc) => matchesFilter(doc, filters));

          return {
            hits,
            nbHits: hits.length,
            page: 0,
            nbPages: 1,
            hitsPerPage: 20,
            processingTimeMS: 0,
            query: query.params?.query ?? '',
            params: '',
            exhaustiveNbHits: true,
          };
        }),
      });
    },
  } as unknown as InstantSearchProps['searchClient'];

  return { searchClient, filtersSeen };
}

function Results() {
  const { items, results } = useHits<FixtureDoc>();
  // react-instantsearch flags the results it synthesises before the first response. Without that
  // distinction a zero-hit answer is indistinguishable from one that has not arrived.
  const responded = !!results && !(results as { __isArtificial?: boolean }).__isArtificial;

  return (
    <ul data-testid="results" data-responded={responded}>
      {items.map((hit) => (
        <li key={hit.objectID} data-testid={`hit-${hit.objectID}`}>
          {hit.name}
        </li>
      ))}
    </ul>
  );
}

function Harness({
  searchClient,
  browsingLevelFilter = true,
  filters,
}: {
  searchClient: InstantSearchProps['searchClient'];
  browsingLevelFilter?: boolean;
  filters?: string[] | string;
}) {
  return (
    <InstantSearch
      searchClient={searchClient}
      indexName="models"
      future={{ preserveSharedStateOnUnmount: true }}
    >
      {browsingLevelFilter ? <BrowsingLevelFilter indexKey="models" filters={filters} /> : null}
      <Results />
    </InstantSearch>
  );
}

/**
 * Waits on the response, never on a hit. Awaiting `hit-pg-checkpoint` instead reads the same when
 * the filter is right, but a regression that renders NOTHING then spends the full 15 s matcher
 * budget and reports a timeout — measured at 14,995 ms against 124 ms for the same mutation here.
 */
async function renderAndSearch(ui: ReactElement) {
  renderWithProviders(ui);
  await expect.element(page.getByTestId('results')).toHaveAttribute('data-responded', 'true');
}

const renderedIds = () =>
  Array.from(page.getByTestId('results').element().children).map((child) =>
    child.getAttribute('data-testid')
  );

function distinctFiltersSeen(filtersSeen: string[]) {
  expect(filtersSeen.length).toBeGreaterThan(0);
  expect(filtersSeen.length).toBeLessThanOrEqual(MAX_SEARCHES);

  return Array.from(new Set(filtersSeen));
}

const receivedFilters = (filtersSeen: string[]) =>
  `filters the search client received: ${JSON.stringify(Array.from(new Set(filtersSeen)))}`;

describe('BrowsingLevelFilter, against a search client that evaluates the filter it receives', () => {
  test('renders the in-level documents and none of the above-level ones', async () => {
    const fake = createFakeSearchClient();
    await renderAndSearch(<Harness searchClient={fake.searchClient} />);

    expect(renderedIds(), receivedFilters(fake.filtersSeen)).toEqual(IN_LEVEL);

    for (const id of ABOVE_LEVEL) {
      expect(
        page.getByTestId(id).elements(),
        `${id} reached the results — ${receivedFilters(fake.filtersSeen)}`
      ).toHaveLength(0);
    }

    // Every request, not just the last: an unfiltered first search would paint above-level
    // documents before the filtered answer replaced them.
    expect(distinctFiltersSeen(fake.filtersSeen)).toEqual(['(nsfwLevel=1)']);
  });

  // Without this, a harness that rendered nothing at all would satisfy the absence assertion above.
  test('negative control: the same fixture renders the above-level documents unfiltered', async () => {
    const fake = createFakeSearchClient();
    await renderAndSearch(<Harness searchClient={fake.searchClient} browsingLevelFilter={false} />);

    expect(renderedIds(), receivedFilters(fake.filtersSeen)).toEqual([...IN_LEVEL, ...ABOVE_LEVEL]);
    expect(distinctFiltersSeen(fake.filtersSeen)).toEqual(['']);
  });

  test('a caller filter is ANDed with the browsing-level clause, not swapped for it', async () => {
    const fake = createFakeSearchClient();
    await renderAndSearch(
      <Harness searchClient={fake.searchClient} filters={['type=LORA OR type=Wildcards']} />
    );

    expect(renderedIds(), receivedFilters(fake.filtersSeen)).toEqual(['hit-pg-lora']);
    expect(distinctFiltersSeen(fake.filtersSeen)).toEqual([
      '(type=LORA OR type=Wildcards) AND (nsfwLevel=1)',
    ]);
  });
});
