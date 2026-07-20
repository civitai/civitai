Got it — you want to **automatically fuzz every handler file** like this without having to hand-craft a test harness for each one. That’s doable if you standardize on your `createEventHandler` contract.

Here’s a clean way to wire it up:

---

### 1. Extend your handler type

Make sure `createEventHandler` returns a shape that exposes the `processor` and some metadata (you’re already doing that). That way the fuzzing framework can introspect it.

---

### 2. Write a generic fuzz runner

This will:

* take a handler,
* generate fake records,
* run through random operations (`create`/`delete`),
* and collect what metrics would have been produced.

```ts
import { faker } from '@faker-js/faker'

// Debug collector
function createDebugActions() {
  const results: any[] = []
  return {
    forMetric: (entity: string, entityId: number) => ({
      as: (userId: number) => ({
        add: (metricType: string, value: number) => {
          results.push({ entity, entityId, userId, metricType, value })
        }
      })
    }),
    getResults: () => results
  }
}

export async function fuzzHandler<TRecord>(
  handler: ReturnType<typeof createEventHandler<TRecord>>,
  makeRecord: () => TRecord,
  iterations = 10
) {
  const debugActions = createDebugActions()

  for (let i = 0; i < iterations; i++) {
    const record = makeRecord()
    const operation = Math.random() > 0.5 ? 'create' : 'delete'

    await handler.processor({
      operation,
      record,
      actions: debugActions,
      pg: {} as any // if your handler doesn’t need pg, just stub it
    })
  }

  return debugActions.getResults()
}
```

---

### 3. Use it with your handler

For your `commentHandler`, you could do:

```ts
import { commentHandler } from './comment.handler'
import { fuzzHandler } from './fuzz'

async function main() {
  const results = await fuzzHandler(
    commentHandler,
    () => ({
      userId: faker.number.int({ min: 1, max: 1000 }),
      modelId: faker.number.int({ min: 1, max: 100 })
    }),
    20
  )
  console.table(results)
}

main()
```

---

### 4. Automate for *all* handlers

If all handler files export their handler(s), you can auto-discover them in a test runner:

```ts
import * as handlers from './handlers'
import { fuzzHandler } from './fuzz'

for (const [name, handler] of Object.entries(handlers)) {
  fuzzHandler(handler, () => /* generator for that handler */)
    .then(results => {
      console.log(`=== ${name} ===`)
      console.table(results)
    })
}
```

For generators, you can either:

* Write one manually per handler (most explicit).
* Or add a `sampleRecord` field to your handler config, so the fuzz framework knows how to generate.

---

### 5. (Optional) Add a `sampleRecord` to handler definitions

Modify `createEventHandler` to accept a `sampleRecord` generator:

```ts
export const commentHandler = createEventHandler<CommentRecord>({
  tables: ['Comment'],
  operations: ['create', 'delete'],
  sampleRecord: () => ({
    userId: faker.number.int({ min: 1, max: 1000 }),
    modelId: faker.number.int({ min: 1, max: 100 })
  }),
  processor: async ({ operation, record, actions }) => {
    ...
  }
})
```

Then the fuzzer can automatically call `handler.sampleRecord()`.

---

✅ This way you can fuzz every handler, collect all metric emissions, and verify that they behave as expected — no manual wiring each time.

Do you want me to show you a version where the fuzzer **auto-discovers every handler in a directory** and runs them all in one go? That’d make it a true automated “fuzz all metrics” test suite.
