---
description: Give context for creating handlers
argument-hint: "[optional Handler to create]"
---

Carefully study the Handler Creation Guide below to prepare to create handlers following best practices.
After reviewing the guide below, say "Which handler would you like to work on?" unless specified below:
Handler to Develop: $ARGUMENTS

# Handler Creation Guide

## Basic Handler Pattern (Best Practice)

Use `createEventHandler` from `./base` for custom handlers:

```typescript
import { createEventHandler } from './base'

export const myHandler = createEventHandler({
  tables: ['TableName'],
  operations: ['create', 'update', 'delete'],
  processor: async (ctx) => {
    const { operation, record, actions, pg, ch } = ctx
    if (!record?.requiredField) return

    // Fetch related data if needed (queries are memoized)
    const related = await pg.queryOne<{ field: type }>(
      'SELECT field FROM "Table" WHERE id = $1',
      [record.id]
    )

    const value = operation === 'create' ? 1 : -1

    // Use forMetric API
    const metric = actions.forMetric('EntityType', record.entityId).as(record.userId)
    metric.add('MetricName', value)

    // Can pass nullable IDs directly - will no-op if null
    const relatedMetric = actions.forMetric('Related', related?.id).as(record.userId)
    relatedMetric.add('MetricName', value)
  }
  // Recommended for automated testing and metric type output verification
  debug: (faker) => ({
    sample: () => ({
      userId: faker.number.int({ min: 1, max: 1000 }),
      entityId: faker.number.int({ min: 1, max: 5000 })
    }),
    pg: (sql: string) => {
      if (sql.includes('"Table"')) {
        return { field: faker.number.int({ min: 1, max: 100 }) }
      }
      return null
    }
  })
})
```

## Available Handler Helpers

### createReactionHandler
For reaction-type events where the reaction name IS the metric name:

```typescript
import { createReactionHandler } from './base'

// With post-processing for additional metrics
export const handler = createReactionHandler({
  table: 'ImageReaction',
  entityType: 'Image',
  entityIdField: 'imageId',
  userIdField: 'userId'  // Optional, defaults to 'userId'
  // Optional post-processing for additional metrics
  async postProcessing({ record, pg, actions }, value) {
    // Fetch related data
    const { ownerId } = await pg.queryOne<{ ownerId: number }>(
      'SELECT "ownerId" FROM "Image" WHERE id = $1',
      [record.imageId]
    ) ?? {}

    // Update owner metrics
    const ownerMetric = actions.forMetric('User', ownerId).as(record.userId)
    ownerMetric.add('ReactionsReceived', value)
  }
})
```

Key features:
- Automatically handles create (+1) and delete (-1) operations
- The `value` parameter in postProcessing is 1 for create, -1 for delete

## Context Properties

- `record` - The active record (current for create/update, old for delete)
- `current` - Record after change (null for delete)
- `old` - Record before change (null for create)
- `operation` - 'create' | 'update' | 'delete'
- `actions` - Metric and cache actions
- `pg` - PostgreSQL query functions (memoized)
- `ch` - ClickHouse query functions

## Best Practices

1. **Use `record` from context** - Automatically provides the right record based on operation
2. **Early return on invalid data** - Use `if (!record?.requiredField) return`
3. **Use forMetric API** - Pass nullable IDs directly, it handles them gracefully
4. **Single value variable** - Use `value = operation === 'create' ? 1 : -1` pattern
5. **Keep it simple** - Let the helpers and API handle the complexity