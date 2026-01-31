# Proposal: Output Schema Cache for Data-Graph

## Problem

Currently, `getSnapshot()` returns the full context values which may include extra fields beyond what output schemas define. For example, resource nodes store enriched data from `ResourceDataProvider` but output schemas only need a subset of fields.

Consumers like `useWhatIfFromGraph` need to send only output-schema-conforming data to the server, which currently requires manual field picking or re-parsing through Zod schemas.

## Proposed Solution

Add an output cache to the DataGraph that stores parsed output values, populated eagerly during evaluation and reused by `validate()` and a new `getOutputValue()` method.

### API Changes

```typescript
// New method to get a single node's output-schema-filtered value
graph.getOutputValue<K extends keyof Ctx>(key: K): Ctx[K]

// New method to get full snapshot with output-filtered values
graph.getOutputSnapshot(): Ctx
```

### Implementation Details

#### 1. New Properties in DataGraph

```typescript
class DataGraph {
  // Store output schemas during node registration
  private outputSchemas: Map<string, ZodSchema> = new Map();

  // Cache: key -> { source: original value, filtered: parsed value }
  private outputCache: Map<string, { source: unknown; filtered: unknown }> = new Map();
}
```

#### 2. Populate Cache During Evaluation

In `_evaluate()`, after storing a node's value:

```typescript
// After: this._ctx[key] = value;

// Try to parse through output schema and cache if valid
const schema = this.outputSchemas.get(key);
if (schema) {
  const result = schema.safeParse(value);
  if (result.success) {
    this.outputCache.set(key, { source: value, filtered: result.data });
  } else {
    // Invalid - don't cache, will be handled by validate()
    this.outputCache.delete(key);
  }
}
```

#### 3. Use Cache in validate()

```typescript
private _validate(saveState = true) {
  for (const entry of this.activeEntries) {
    const currentValue = this._ctx[entry.key];
    const cached = this.outputCache.get(entry.key);

    // Cache hit - node already validated during evaluation
    if (cached && Object.is(cached.source, currentValue)) {
      if (saveState) {
        this._ctx[entry.key] = cached.filtered;
      }
      continue;
    }

    // Cache miss - parse through output schema
    const result = def.output.safeParse(currentValue);
    if (result.success) {
      this.outputCache.set(entry.key, { source: currentValue, filtered: result.data });
      if (saveState) {
        this._ctx[entry.key] = result.data;
      }
    } else {
      errors.set(entry.key, ...);
    }
  }
}
```

#### 4. New getOutputValue() Method

```typescript
getOutputValue<K extends keyof Ctx>(key: K): Ctx[K] {
  const currentValue = this._ctx[key];
  const cached = this.outputCache.get(key as string);

  // Return cached if source unchanged
  if (cached && Object.is(cached.source, currentValue)) {
    return cached.filtered as Ctx[K];
  }

  // Cache miss - parse and cache
  const schema = this.outputSchemas.get(key as string);
  if (!schema) return currentValue;

  const result = schema.safeParse(currentValue);
  if (result.success) {
    this.outputCache.set(key as string, { source: currentValue, filtered: result.data });
    return result.data;
  }

  // Validation failed - return original (let validate() handle errors)
  return currentValue;
}
```

#### 5. Cache Invalidation

In `_notifyChanges()`:
```typescript
// Already handled - cache is populated during _evaluate()
// Invalid entries are deleted, valid entries are updated
```

When deactivating branches:
```typescript
for (const key of deactivatedKeys) {
  delete this._ctx[key];
  this.outputCache.delete(key);
}
```

### Overhead Analysis

| Operation | Cost |
|-----------|------|
| Map lookup per node | ~nanoseconds |
| Object.is comparison | ~nanoseconds |
| Output schema parsing | Same as current (just moved earlier) |

For valid nodes: 1 parse in evaluate, cache hit in validate (no extra work)
For invalid nodes: 1 parse in evaluate (fails), 1 parse in validate (same as current)

### Benefits

1. **Validate becomes faster**: Cache hits skip re-parsing for unchanged valid nodes
2. **getOutputValue() is cheap**: Returns cached parsed values
3. **Single source of truth**: Cache populated during evaluation, reused everywhere
4. **No breaking changes**: New methods, existing API unchanged

### When to Implement

Consider implementing this if:
- Multiple consumers need output-filtered values
- Output schema parsing becomes a measurable bottleneck
- You want validated outputs available without calling validate()

For simpler cases (e.g., filtering resources in one hook), a manual picker function may suffice:

```typescript
// Simple alternative - co-locate with schema definition
export function pickResourceFields(resource: GenerationResource | undefined): ResourceData | undefined {
  if (!resource) return undefined;
  return {
    id: resource.id,
    model: { type: resource.model?.type },
    strength: resource.strength,
    trainedWords: resource.trainedWords,
    epochDetails: resource.epochDetails,
  };
}
```

## Status

**Deferred** - Using simpler picker function approach for now. Revisit if output filtering is needed in more places.
