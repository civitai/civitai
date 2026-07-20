/**
 * Local logic test for the comic engagement handler.
 *
 * Runs each scenario through handler.process() with mocked actions/db,
 * captures emitted metric events, and asserts the expected entity/metric/value.
 *
 * Usage:
 *   npx tsx -r tsconfig-paths/register scripts/test-comic-engagements.ts
 */

import { comicEngagementHandler } from '../src/handlers/comic-engagements'
import { DebugActions } from './generate-types'
import { Operation } from '../src/types/events'

interface EngagementRow {
  userId: number
  projectId: number
  type: 'None' | 'Notify' | 'Hide'
  readChapters: number[]
  createdAt?: Date
}

interface ExpectedMetric {
  metricType: string
  value: number
}

interface Scenario {
  name: string
  operation: Operation
  old: EngagementRow | null
  current: EngagementRow | null
  expected: ExpectedMetric[]
}

const baseRow = (overrides: Partial<EngagementRow> = {}): EngagementRow => ({
  userId: 1,
  projectId: 42,
  type: 'None',
  readChapters: [],
  ...overrides
})

const scenarios: Scenario[] = [
  {
    name: 'create — Notify, empty readChapters',
    operation: 'create',
    old: null,
    current: baseRow({ type: 'Notify' }),
    expected: [{ metricType: 'followerCount', value: 1 }]
  },
  {
    name: 'create — None, readChapters=[10,11]',
    operation: 'create',
    old: null,
    current: baseRow({ type: 'None', readChapters: [10, 11] }),
    expected: [
      { metricType: 'readerCount', value: 1 },
      { metricType: 'chapterReadCount', value: 2 }
    ]
  },
  {
    name: 'create — Notify with reads',
    operation: 'create',
    old: null,
    current: baseRow({ type: 'Notify', readChapters: [10, 11, 12] }),
    expected: [
      { metricType: 'followerCount', value: 1 },
      { metricType: 'readerCount', value: 1 },
      { metricType: 'chapterReadCount', value: 3 }
    ]
  },
  {
    name: 'create — Hide',
    operation: 'create',
    old: null,
    current: baseRow({ type: 'Hide' }),
    expected: [{ metricType: 'hiddenCount', value: 1 }]
  },
  {
    name: 'update — type None → Notify, reads unchanged',
    operation: 'update',
    old: baseRow({ type: 'None', readChapters: [5] }),
    current: baseRow({ type: 'Notify', readChapters: [5] }),
    expected: [{ metricType: 'followerCount', value: 1 }]
  },
  {
    name: 'update — first chapter read (empty → [100])',
    operation: 'update',
    old: baseRow({ type: 'Notify', readChapters: [] }),
    current: baseRow({ type: 'Notify', readChapters: [100] }),
    expected: [
      { metricType: 'chapterReadCount', value: 1 },
      { metricType: 'readerCount', value: 1 }
    ]
  },
  {
    name: 'update — extra chapters read ([100,200] → [100,200,300,400])',
    operation: 'update',
    old: baseRow({ type: 'Notify', readChapters: [100, 200] }),
    current: baseRow({ type: 'Notify', readChapters: [100, 200, 300, 400] }),
    expected: [{ metricType: 'chapterReadCount', value: 2 }]
  },
  {
    name: 'update — reads cleared ([100] → [])',
    operation: 'update',
    old: baseRow({ type: 'Notify', readChapters: [100] }),
    current: baseRow({ type: 'Notify', readChapters: [] }),
    expected: [
      { metricType: 'chapterReadCount', value: -1 },
      { metricType: 'readerCount', value: -1 }
    ]
  },
  {
    name: 'update — Notify → Hide with reads unchanged',
    operation: 'update',
    old: baseRow({ type: 'Notify', readChapters: [10] }),
    current: baseRow({ type: 'Hide', readChapters: [10] }),
    expected: [
      { metricType: 'followerCount', value: -1 },
      { metricType: 'hiddenCount', value: 1 }
    ]
  },
  {
    name: 'update — no-op (None → None, reads unchanged)',
    operation: 'update',
    old: baseRow({ type: 'None', readChapters: [1, 2] }),
    current: baseRow({ type: 'None', readChapters: [1, 2] }),
    expected: []
  },
  {
    name: 'delete — Notify with reads',
    operation: 'delete',
    old: baseRow({ type: 'Notify', readChapters: [1, 2, 3] }),
    current: null,
    expected: [
      { metricType: 'followerCount', value: -1 },
      { metricType: 'readerCount', value: -1 },
      { metricType: 'chapterReadCount', value: -3 }
    ]
  },
  {
    name: 'delete — None with no reads (no-op)',
    operation: 'delete',
    old: baseRow({ type: 'None', readChapters: [] }),
    current: null,
    expected: []
  }
]

const noopDb = {
  pg: {
    query: async () => [],
    queryOne: async () => null,
    exec: async () => 1
  },
  ch: {
    query: async () => [],
    insert: async () => undefined
  }
}

function sortMetrics(rows: { metricType: string; value: number }[]) {
  return [...rows].sort((a, b) => a.metricType.localeCompare(b.metricType))
}

async function run() {
  let passed = 0
  let failed = 0

  for (const scenario of scenarios) {
    const actions = new DebugActions('comicEngagementHandler', scenario.operation)

    // record reflects the active row per handler convention:
    // create -> current, delete -> old, update -> current
    const record =
      scenario.operation === 'delete' ? scenario.old : scenario.current

    await comicEngagementHandler.process({
      old: scenario.old,
      current: scenario.current,
      record: record as EngagementRow,
      operation: scenario.operation,
      actions: actions as any,
      ...(noopDb as any)
    })

    const emitted = actions.getResults().map((r) => ({
      metricType: r.metricType,
      value: r.value ?? 0,
      entityType: r.entityType
    }))

    // All comic engagement metrics target entityType='Comic'; sanity check.
    const wrongEntity = emitted.find((m) => m.entityType !== 'Comic')
    const expected = sortMetrics(scenario.expected)
    const actual = sortMetrics(
      emitted.map(({ metricType, value }) => ({ metricType, value }))
    )
    const ok =
      !wrongEntity &&
      JSON.stringify(actual) === JSON.stringify(expected)

    if (ok) {
      passed++
      console.log(`  ✓ ${scenario.name}`)
    } else {
      failed++
      console.log(`  ✗ ${scenario.name}`)
      console.log(`      expected: ${JSON.stringify(expected)}`)
      console.log(`      actual:   ${JSON.stringify(actual)}`)
      if (wrongEntity) {
        console.log(`      unexpected entityType: ${wrongEntity.entityType}`)
      }
    }
  }

  console.log(`\n${passed}/${passed + failed} scenarios passed`)
  if (failed > 0) process.exit(1)
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
