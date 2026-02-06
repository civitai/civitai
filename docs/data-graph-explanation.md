# DataGraph: A Reactive State Management System

## Overview

DataGraph is a **reactive, type-safe state management system** that organizes application state as a directed acyclic graph (DAG) of interconnected nodes. Think of it as a spreadsheet where cells (nodes) can depend on other cells, and changes automatically propagate through the system.

```
┌─────────────────────────────────────────────────────────────────┐
│                         DataGraph                               │
│                                                                 │
│   ┌──────┐      ┌──────┐      ┌──────┐                         │
│   │ Node │─────▶│ Node │─────▶│Computed│                        │
│   │  A   │      │  B   │      │   C    │                        │
│   └──────┘      └──────┘      └────────┘                        │
│       │              │                                          │
│       └──────┬───────┘                                          │
│              ▼                                                  │
│         ┌────────┐                                              │
│         │ Effect │                                              │
│         └────────┘                                              │
└─────────────────────────────────────────────────────────────────┘
```

---

## Core Concepts

### 1. Nodes

Nodes are the fundamental building blocks. Each node has:
- **Key**: Unique identifier (e.g., `'steps'`, `'model'`)
- **Schema**: Zod schema defining valid values (`output`)
- **Default Value**: Initial value when no input provided
- **Meta**: Optional metadata (e.g., `{ min: 1, max: 100 }` for a slider)

```typescript
graph.node('steps', {
  input: z.number().optional(),
  output: z.number().min(2).max(20),
  defaultValue: 20,
  meta: { min: 1, max: 100, label: 'Steps' }
})
```

### 2. Dependencies

Dependencies define which nodes a node "listens to". When a dependency changes, the dependent node re-evaluates.

```typescript
// This node depends on 'workflow' - it re-evaluates when workflow changes
graph.node('model', (ctx) => ({
  output: z.string(),
  defaultValue: ctx.workflow === 'txt2img' ? 'sdxl' : 'flux',
}), ['workflow'])  // <-- dependency array
```

**Dependency Flow:**
```
  workflow ────────┐
                   ▼
              ┌─────────┐
              │  model  │  (re-evaluates when workflow changes)
              └─────────┘
```

### 3. Computed Values

Computed values are **derived** from other nodes. They cannot be set directly - they're always calculated.

```typescript
graph.computed('totalCost',
  (ctx) => ctx.steps * ctx.pricePerStep,
  ['steps', 'pricePerStep']  // dependencies
)
```

**Key difference from nodes:**
- **Node**: Can be set by user input
- **Computed**: Always derived, read-only

### 4. Effects

Effects run **side effects** when dependencies change. They can modify other nodes using the `set` function.

```typescript
graph.effect((ctx, ext, set) => {
  // When model changes, reset steps to default
  if (ctx.model === 'turbo') {
    set('steps', 4);  // Turbo models need fewer steps
  }
}, ['model'])  // runs when 'model' changes
```

**Effect Flow:**
```
  model changes
       │
       ▼
  ┌─────────────────────┐
  │  Effect runs        │
  │  set('steps', 4)    │
  └─────────────────────┘
       │
       ▼
  steps node updated
       │
       ▼
  dependents re-evaluate
```

---

## Discriminators: Conditional Branches

Discriminators enable **different node sets based on a value**. Think of them as "switch statements" for your graph structure.

```typescript
graph
  .node('workflow', { output: z.enum(['txt2img', 'img2img']), defaultValue: 'txt2img' })
  .discriminator('workflow', {
    txt2img: txt2imgGraph,  // Only these nodes exist when workflow='txt2img'
    img2img: img2imgGraph,  // Only these nodes exist when workflow='img2img'
  })
```

**Visual representation:**
```
                    ┌─────────────┐
                    │  workflow   │
                    │ 'txt2img'   │
                    └──────┬──────┘
                           │
            ┌──────────────┴──────────────┐
            ▼                             ▼
     workflow = 'txt2img'          workflow = 'img2img'
    ┌─────────────────┐           ┌─────────────────┐
    │  prompt         │           │  sourceImage    │
    │  negPrompt      │           │  denoiseStrength│
    │  seed           │           │  prompt         │
    └─────────────────┘           └─────────────────┘
```

When `workflow` changes from `'txt2img'` to `'img2img'`:
1. All txt2img-specific nodes are **removed** from context
2. All img2img-specific nodes are **added** and initialized
3. Subscribers are notified

---

## Evaluation Loop

The graph uses a **single-pass evaluation loop** with automatic rewinding:

```
┌─────────────────────────────────────────────────────────────────┐
│                    Evaluation Loop                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. Start at index 0                                            │
│  2. For each entry:                                             │
│     ┌────────────────────────────────────────────────────────┐  │
│     │ if (no deps changed) → skip                            │  │
│     │ if (deps changed) → re-evaluate → mark as changed      │  │
│     └────────────────────────────────────────────────────────┘  │
│  3. If effect sets an earlier node → REWIND to that index       │
│  4. Continue until end of entries                               │
│  5. Notify all subscribers                                      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Example with rewinding:**
```
Entries: [A, B, C, D, E]
         0  1  2  3  4

1. Process A (changed)
2. Process B (depends on A, re-evaluates)
3. Process C (no deps changed, skip)
4. Process D (effect that sets A!)
   └── REWIND to index 0
5. Process A again (now with new value)
6. Process B again
7. ... continues until stable
```

---

## Deep Dive: Effects Updating Upstream Nodes

Effects are powerful because they can modify nodes that were already processed earlier in the evaluation. This triggers **rewinding** - the loop jumps back to re-process affected nodes.

### Real-World Example: Model Changes Affect Steps

Consider this graph where changing the model should constrain the steps value:

```typescript
graph
  .node('model', { output: z.string(), defaultValue: 'sdxl' })
  .node('steps', (ctx) => ({
    output: z.number(),
    defaultValue: 20,
    meta: {
      min: 1,
      max: ctx.model === 'turbo' ? 8 : 100  // turbo has limited steps
    }
  }), ['model'])
  .effect((ctx, ext, set) => {
    // Clamp steps to valid range when model changes
    const max = ctx.model === 'turbo' ? 8 : 100;
    if (ctx.steps > max) {
      set('steps', max);  // <-- Updates upstream node!
    }
  }, ['model', 'steps'])
```

### Step-by-Step Evaluation Trace

**Scenario:** User changes `model` from `'sdxl'` to `'turbo'` while `steps = 50`

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  EVALUATION TRACE: set({ model: 'turbo' })                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Initial state: { model: 'sdxl', steps: 50 }                                │
│  Changed set: ['model']                                                     │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ PASS 1                                                              │    │
│  ├─────────────────────────────────────────────────────────────────────┤    │
│  │                                                                     │    │
│  │  Index 0: model (node)                                              │    │
│  │  ├── 'model' in changed? YES                                        │    │
│  │  ├── Update value: 'sdxl' → 'turbo'                                 │    │
│  │  └── Mark 'model' as changed ✓                                      │    │
│  │                                                                     │    │
│  │  Index 1: steps (node)                                              │    │
│  │  ├── Deps ['model'] changed? YES                                    │    │
│  │  ├── Re-evaluate factory → meta.max now = 8                         │    │
│  │  ├── Value unchanged (still 50)                                     │    │
│  │  └── Skip marking as changed                                        │    │
│  │                                                                     │    │
│  │  Index 2: effect                                                    │    │
│  │  ├── Deps ['model', 'steps'] changed? YES ('model' changed)         │    │
│  │  ├── Run effect...                                                  │    │
│  │  │   ├── max = 8 (turbo model)                                      │    │
│  │  │   ├── steps (50) > max (8)? YES                                  │    │
│  │  │   └── set('steps', 8) called!                                    │    │
│  │  │                                                                  │    │
│  │  │   ┌──────────────────────────────────────────┐                   │    │
│  │  │   │  🔄 REWIND TRIGGERED                     │                   │    │
│  │  │   │  'steps' is at index 1                   │                   │    │
│  │  │   │  Current index is 2                      │                   │    │
│  │  │   │  Jump back to index 1                    │                   │    │
│  │  │   └──────────────────────────────────────────┘                   │    │
│  │  │                                                                  │    │
│  └──┴──────────────────────────────────────────────────────────────────┘    │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ PASS 2 (after rewind)                                               │    │
│  ├─────────────────────────────────────────────────────────────────────┤    │
│  │                                                                     │    │
│  │  Index 1: steps (node)                                              │    │
│  │  ├── 'steps' in changed? YES (effect set it)                        │    │
│  │  ├── Value: 50 → 8                                                  │    │
│  │  └── Mark 'steps' as changed ✓                                      │    │
│  │                                                                     │    │
│  │  Index 2: effect                                                    │    │
│  │  ├── Deps ['model', 'steps'] changed? YES ('steps' changed)         │    │
│  │  ├── Run effect...                                                  │    │
│  │  │   ├── max = 8                                                    │    │
│  │  │   ├── steps (8) > max (8)? NO                                    │    │
│  │  │   └── No set() called - stable!                                  │    │
│  │  └── Continue to next entry                                         │    │
│  │                                                                     │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
│  Final state: { model: 'turbo', steps: 8 }                                  │
│  Subscribers notified: ['model', 'steps']                                   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Visual: The Rewind Mechanism

```
            FORWARD PASS                          REWIND
        ─────────────────►                    ◄─────────────

   ┌─────────┐    ┌─────────┐    ┌─────────┐
   │  model  │───▶│  steps  │───▶│ effect  │
   │ (idx 0) │    │ (idx 1) │    │ (idx 2) │
   └─────────┘    └─────────┘    └────┬────┘
                       ▲              │
                       │              │
                       └──────────────┘
                        set('steps', 8)
                        causes rewind
                        to index 1

   Timeline:
   ─────────────────────────────────────────────────────────►

   [0]─────[1]─────[2]─┐
    model   steps  effect
                       │ set('steps', 8)
                       │
              ┌────────┘  REWIND!
              ▼
           ──[1]─────[2]──►
             steps  effect
             (8)    (no change)

                    DONE ✓
```

### Why This Matters

The rewind mechanism ensures **consistency**:

- Effects can enforce constraints (min/max, dependencies between values)
- All downstream nodes see the corrected value
- The graph reaches a stable state before notifying subscribers

**Without rewinding**, you'd get inconsistent states:
```
❌ Bad: { model: 'turbo', steps: 50 }  // steps exceeds turbo's max!
✓ Good: { model: 'turbo', steps: 8 }   // consistent after rewind
```

### Loop Detection

If effects keep modifying values indefinitely, the graph throws an error:

```typescript
// ❌ Infinite loop - effect keeps toggling value
graph
  .node('toggle', { output: z.boolean(), defaultValue: false })
  .effect((ctx, ext, set) => {
    set('toggle', !ctx.toggle);  // Always changes!
  }, ['toggle'])

// Error: "Effect loop detected" (after 1000 iterations)
```

---

## API Quick Reference

### Creating a Graph

```typescript
const graph = new DataGraph<{}, ExternalCtx>()
  .node('key', { output: schema, defaultValue, meta })
  .node('dynamic', (ctx, ext) => ({ ... }), ['deps'])
  .computed('derived', (ctx) => value, ['deps'])
  .effect((ctx, ext, set) => { ... }, ['deps'])
  .discriminator('key', { branch1: graph1, branch2: graph2 });
```

### Using the Graph

```typescript
// Initialize
const ctx = graph.init({ steps: 30 }, externalCtx);

// Update values
graph.set({ steps: 50 });

// Subscribe to changes
const unsubscribe = graph.subscribe('steps', () => {
  console.log('steps changed!');
});

// Get current state
const snapshot = graph.getSnapshot('steps');
// { value: 50, meta: {...}, error: undefined, isComputed: false }
```

---

## Key Insights

1. **Order matters**: Entries are evaluated in definition order. Define dependencies before dependents.

2. **Effects can cause loops**: The graph detects infinite loops (>1000 iterations) and throws an error.

3. **Discriminators are lazy**: Branch graphs can be factories that only instantiate when needed.

4. **Meta is for UI**: Use meta to pass UI hints (min/max, labels, options) without polluting the value.

5. **Validation is separate**: Call `graph.validate()` to check all values against their output schemas.

```
┌─────────────────────────────────────────────────────────────────┐
│                    Mental Model                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   DataGraph ≈ Spreadsheet                                       │
│   Node ≈ Cell with formula                                      │
│   Dependencies ≈ Cell references                                │
│   Computed ≈ Formula-only cell (can't type in it)               │
│   Effect ≈ Macro that runs when cells change                    │
│   Discriminator ≈ Different sheets based on a dropdown          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```
