# Prompt Snippets — Nested Wildcard Resolution (Walkthrough)

**Status:** draft for review
**Companion docs:**

- [prompt-snippets.md](./prompt-snippets.md) (product/UX plan)
- [prompt-snippets-schema.md](./prompt-snippets-schema.md) (schema spec)
- [prompt-snippets-schema-examples.md](./prompt-snippets-schema-examples.md) (populated tables)

A walkthrough doc to make nested-wildcard resolution concrete. Uses a small invented wildcard pack (simpler than fullFeatureFantasy) so the trees and call stacks fit on a screen. Diagrams are ASCII art; the algorithms behind them apply unchanged at any scale.

---

## Syntax — one symbol everywhere

Our system uses **`#category`** as the only reference syntax, both in user-typed prompts and inside category values. Real wildcard model files (e.g., fullFeatureFantasy) use the older Dynamic Prompts convention `__name__` for nested references — we transform `__name__` → `#name` at import time. The stored JSONB values, the resolver, and the user-facing UI all see `#` only.

What's preserved literally on import:

- Alternation: `{a|b|c}`
- Weighted alternation: `{3.0::a|2.5::b|...}`
- Multi-pick: `{1-2$$a|b|c}`
- SD attention syntax: `(weight:1.2)`

What's transformed on import:

- `__some_name__` → `#some_name` (every nested reference)

The semantics are unchanged; only the reference syntax is normalized.

---

## The example wildcard pack

Imagine a System-kind WildcardSet called **"MyFantasyPack v1.0"** with 7 categories. Their `values` JSONB arrays after import (already normalized to `#`):

| Category name | values |
|----|----|
| `character` | `["#hero", "#villain"]` |
| `hero` | `["a brave knight in {silver\|gold} armor", "a noble paladin with a #weapon"]` |
| `villain` | `["a dark #sorcerer_type wielding a #weapon"]` |
| `sorcerer_type` | `["necromancer", "warlock", "demonologist"]` |
| `weapon` | `["{cursed\|bloodied} sword", "obsidian staff", "rune-etched dagger"]` |
| `setting` | `["a {misty\|dusty} #location"]` |
| `location` | `["forest", "ruined temple", "crystal cavern"]` |

Notice the patterns:

- `character` is a **dispatcher** — it just picks between `#hero` and `#villain`.
- `hero` and `villain` reference deeper categories (`#weapon`, `#sorcerer_type`).
- `weapon` is a **leaf** with internal `{cursed|bloodied}` alternation but no nested refs.
- `setting` and `location` are an independent two-level chain unrelated to characters.

This mirrors how real wildcard packs (like fullFeatureFantasy) layer abstraction.

---

## Diagram 1 — Static dependency graph

Arrow `A → B` means "A's values contain `#B`."

```
                  character
                  /       \
                 ▼         ▼
              hero ─────► weapon ◄─── villain
                              ▲          │
                              │          ▼
                              │      sorcerer_type
                              │
                              │
   setting ─► location        │ (independent subgraph,
                              │  not connected to character)
                              │
                            (leaf categories: weapon, sorcerer_type, location
                             — no further references)
```

Properties:

- **No cycles.** Wildcard packs are usually authored as a DAG (Directed Acyclic Graph — nodes connected by directional arrows that never loop back to where they started). Our resolver enforces this — cycles are detected and treated as Dirty.
- **Multiple roots.** `character` and `setting` are both top-level entry points (referenced from prompts directly).
- **Shared leaves.** `weapon` is referenced by both `hero` and `villain` — no duplication, both branches resolve to the same pool.

---

## Diagram 2 — Audit-time graph walk

When a user imports MyFantasyPack v1.0, the audit job parses each category's `values` for `#refs` and walks the dependency graph in **topological order** (leaves first, then categories that depend on them).

```
Pass 1: leaf categories (no nested refs)
  ┌─────────────────────────────┐
  │ weapon         (Clean, Lvl 1│ ← audit literal text only
  │ sorcerer_type  (Clean, Lvl 1│
  │ location       (Clean, Lvl 1│
  └─────────────────────────────┘
                   │
                   ▼
Pass 2: categories that ref leaves only
  ┌─────────────────────────────┐
  │ hero    (Clean, Lvl 1)      │ ← audit literal text + propagate nsfwLevel
  │         refs: weapon         │   from referenced clean categories
  │ villain (Clean, Lvl 1)      │
  │         refs: weapon, sorcerer_type
  │ setting (Clean, Lvl 1)      │
  │         refs: location       │
  └─────────────────────────────┘
                   │
                   ▼
Pass 3: top-level categories
  ┌─────────────────────────────┐
  │ character (Clean, Lvl 1)    │ ← propagated from hero, villain
  │           refs: hero, villain│
  └─────────────────────────────┘
```

Each pass:

1. Audit the category's literal text via `auditPromptEnriched`.
2. Compute its **own** `nsfwLevel` from literal content rules.
3. Propagate: `effective_nsfwLevel = own_nsfwLevel | union(child.nsfwLevel for child in nested refs)`.
4. If any referenced child is `Dirty` or missing, the parent **does not** become Dirty (parent's literal content is what's audited). Resolution at gen time will skip dirty branches.
5. Cycles (if any sneak through) → all participants flagged `Dirty` with note "circular reference."

After the walk, every `WildcardSetCategory` row has its final `auditStatus` and effective `nsfwLevel` set.

### What a cycle looks like

```
   a → b → c → a    ← detected during graph build; participants flagged Dirty
```

Concretely, if `a.values = ["#b"]`, `b.values = ["#c"]`, `c.values = ["#a"]`, the topological sort fails. All three categories are marked `Dirty` with `auditNote: "cycle: a→b→c→a"`.

---

## Diagram 3 — Single-generation resolution call stack

User prompt:

```
"A #character emerges from the shadows of #setting"
```

User has MyFantasyPack v1.0 active, no explicit selections (defaults = full pool), `seed = 42`. Total combinations: 2 (`character`'s 2 values) × 1 (`setting`'s 1 value) = 2 → 2 workflow steps fan out.

**Workflow step 1**, picking `#hero` for `#character` and the only setting value:

```
┌─ Top-level expansion ──────────────────────────────────────────────────┐
│ Input prompt: "A #character emerges from the shadows of #setting"     │
│                                                                        │
│ #character pool: ["#hero", "#villain"]                                │
│ Seeded pick:     "#hero"                             [seed: 42, slot 0]│
│                                                                        │
│ #setting pool:   ["a {misty|dusty} #location"]                        │
│ Seeded pick:     (only option)                       [seed: 42, slot 1]│
│                                                                        │
│ After top-level substitution:                                         │
│ "A #hero emerges from the shadows of a {misty|dusty} #location"       │
└──────────────────┬─────────────────────────────────────────────────────┘
                   │
                   ▼
┌─ expandValue(#hero, sourceSetId=MyFantasyPack, depth=1) ──────────────┐
│ Lookup category 'hero' in same set → Clean                            │
│ hero pool:  ["a brave knight in {silver|gold} armor",                 │
│              "a noble paladin with a #weapon"]                        │
│ Seeded pick: "a noble paladin with a #weapon"        [seed: 42, d=1]  │
│                                                                        │
│ Recurse into picked value's #refs ──┐                                 │
└──────────────────────────────────────┼────────────────────────────────┘
                                       │
                                       ▼
┌─ expandValue(#weapon, sourceSetId=MyFantasyPack, depth=2) ────────────┐
│ Lookup 'weapon' → Clean                                                │
│ weapon pool: ["{cursed|bloodied} sword", "obsidian staff",            │
│               "rune-etched dagger"]                                    │
│ Seeded pick: "{cursed|bloodied} sword"               [seed: 42, d=2]  │
│                                                                        │
│ Resolve alternation {cursed|bloodied} → "bloodied"   [seed: 42, alt]  │
│                                                                        │
│ No more #refs, return "bloodied sword"                                │
└──────────────────┬─────────────────────────────────────────────────────┘
                   │ return up
                   ▼
hero result becomes: "a noble paladin with a bloodied sword"
                   │
                   ▼
┌─ expandValue(#location, sourceSetId=MyFantasyPack, depth=1) ──────────┐
│ Lookup 'location' → Clean                                             │
│ location pool: ["forest", "ruined temple", "crystal cavern"]          │
│ Seeded pick: "ruined temple"                         [seed: 42, d=1]  │
│ No #refs, return.                                                     │
└──────────────────┬─────────────────────────────────────────────────────┘
                   │ return up
                   ▼
setting result becomes: "a misty ruined temple"   ({misty|dusty} resolved → misty)
                   │
                   ▼
┌─ Final composed prompt ────────────────────────────────────────────────┐
│ "A a noble paladin with a bloodied sword emerges from the shadows     │
│  of a misty ruined temple"                                            │
└────────────────────────────────────────────────────────────────────────┘
```

The resolver returns this composed prompt for the workflow step. (The awkward "A a noble" is a wildcard-author concern — they'd typically write the prompt as `"A character: #character"` or rely on prompt-engineering conventions to handle articles.)

**Workflow step 2** would do the same with `#villain` → `#sorcerer_type` and `#weapon`, producing a different prompt.

### Step metadata records the path

Each workflow step's metadata captures the resolution chain so we can reconstruct what happened:

```jsonc
{
  "snippetReferences": [
    {
      "category": "character",
      "referencePosition": 0,
      "resolvedValues": [
        {
          "wildcardSetId": 21,
          "categoryId": 401,    // 'character'
          "valueIndex": 0,      // picked #hero
          "value": "#hero",
          "nestedExpansion": {
            "category": "hero",
            "categoryId": 402,
            "valueIndex": 1,    // picked the paladin one
            "value": "a noble paladin with a #weapon",
            "nested": [
              { "category": "weapon", "categoryId": 405, "valueIndex": 0, "value": "{cursed|bloodied} sword", "alternationPick": "bloodied" }
            ]
          }
        }
      ]
    },
    {
      "category": "setting",
      "referencePosition": 1,
      "resolvedValues": [
        {
          "wildcardSetId": 21, "categoryId": 406, "valueIndex": 0,
          "value": "a {misty|dusty} #location",
          "alternationPick": "misty",
          "nested": [
            { "category": "location", "categoryId": 407, "valueIndex": 1, "value": "ruined temple" }
          ]
        }
      ]
    }
  ],
  "samplingSeed": 42,
  "cartesianTotal": 2,
  "sampledTo": 2
}
```

Captures everything needed to re-run this exact step (same seed → same result tree).

---

## Diagram 4 — Edge case: dirty nested ref

Suppose audit marks `weapon` as `Dirty` (some line in its values triggered a rule). What happens to a generation that references `#villain`?

```
At generation time:
  villain pool: ["a dark #sorcerer_type wielding a #weapon"]
  Pick: the only value
  → "a dark #sorcerer_type wielding a #weapon"

  Recurse into #sorcerer_type → resolves normally (Clean)
  Recurse into #weapon:
     ┌──────────────────────────────────────────┐
     │ Lookup 'weapon' → DIRTY                  │
     │ Skip this expansion — return ""          │
     └──────────────────────────────────────────┘

  After substitution:
  "a dark warlock wielding a "    ← dangling, ugly text
```

Two implementation choices for what "skip" means:

- **Empty string substitution** (shown above): produces dangling text but the prompt still runs.
- **Drop the entire value from the parent's pool**: at the moment we pick a value containing `#weapon`, we check transitively that all nested refs resolve. If any are unresolvable, we skip this value and pick another.

The second is cleaner — no dangling text in the final prompt. But it requires a pre-check pass over each picked value before substitution. Recommendation: **drop the value, pick another from the parent pool**. If the entire parent pool is unresolvable, the parent reference itself becomes unresolvable for this generation and we surface a warning.

---

## Diagram 5 — Edge case: depth limit / cycle

Cycles are pre-detected at audit time, but new ones could appear mid-life if categories are added. Worst case at gen time:

```
Resolution path: character → ??? → ??? → ??? → ???
                 depth: 1     2     3     4     5

If depth exceeds MAX_DEPTH (10):
  Abort current branch, return literal text "#name" unsubstituted.
  Log warning for moderation review.

If revisiting a name already in the path:
  Abort current branch, return literal text "#name" unsubstituted.
  Log warning for moderation review.
```

The point of returning literal text rather than an error: a single bad branch shouldn't kill the whole generation. The user gets a prompt with some `#name` text in it (visible cosmetic issue) instead of a rejected submission.

---

## Diagram 6 — Scope boundary: nested refs stay within source set

Alice has two active sets:

- Set 30 (User-kind, "My snippets") — has category `character`
- Set 21 (System-kind, MyFantasyPack v1.0) — has category `character` AND nested deps

She prompts: `"A #character emerges"`. Defaults = full pool, so she gets values from both sets:

```
#character pool (merged at picker layer):
  • From Set 30: "Zelda"                        ← Alice's personal snippet
  • From Set 21: "#hero"                        ← MyFantasyPack
  • From Set 21: "#villain"

If picked value is "Zelda":
  No nested refs → final value is literally "Zelda"

If picked value is "#hero":
  Recurse — but ONLY within Set 21's namespace.
  Set 30's categories are NOT visible during nested resolution.

  Resolves to: "a noble paladin with a #weapon"
  → "#weapon" lookup happens in Set 21
  → returns "obsidian staff" or whatever

  Even if Alice has a "weapon" category in Set 30, it's not used here.
```

The boundary is: top-level merging happens across sets at the picker layer; nested resolution happens within whatever set the value originated from. Wildcard authors can trust their internal references; users can't accidentally pollute them.

---

## Resolver algorithm sketch

```ts
// In snippetExpansion.ts
function expandValue(
  value: string,
  sourceSetId: number,
  seed: SeedState,
  depth = 0,
  visited: Set<string> = new Set(),
): string {
  if (depth > MAX_DEPTH) return value;

  // 1. Resolve nested #name refs
  let result = value.replace(/#([a-zA-Z][a-zA-Z0-9_]*)/g, (match, name) => {
    if (visited.has(name)) return match;  // cycle
    const category = lookupCategory(sourceSetId, name);
    if (!category || category.auditStatus !== 'Clean') return '';  // skip
    const picked = pickWeighted(category.values, seed);
    return expandValue(picked, sourceSetId, seed, depth + 1, new Set([...visited, name]));
  });

  // 2. Resolve {a|b|c} alternation, weights, multi-pick
  result = expandAlternation(result, seed);

  return result;
}
```

The seed-driven `pickWeighted` and `expandAlternation` keep determinism intact — same submission seed produces byte-identical expansions.

> **Parser note:** `#?category` (random-pick mode) is only valid at the top level of the user's prompt, not inside a value. Nested refs are always batch-style `#name`. If a wildcard model's source file used `#?` inside a value, our import would either reject it or treat it as `#` — to confirm during implementation.

---

## Open questions for review

1. **Skip behavior on dirty/missing nested ref.** Two options shown in Diagram 4:
   - (a) Empty-string substitution → may leave dangling/awkward text in prompts.
   - (b) Drop the parent value, pick another from the parent's pool → cleaner output but requires a pre-check before substitution.

   Recommendation: **(b)**. Cleaner final prompts. The check itself is cheap (one lookup per nested ref before commit).

2. **NSFW level propagation visibility in picker.** When a category's `effective nsfwLevel` differs from its literal `nsfwLevel` (because of nested refs), do we surface that?
   - Show effective only — picker shows one number, user sees the actual filtering result.
   - Show both with a tooltip — power-user transparency.
   - Show effective in the picker; debug view in admin tooling.

   Recommendation: **show effective only**, hide the literal one. Consistency with how downstream filtering will work.

3. **Cycle handling — during audit only, or also at gen time?** Audit-time prevention catches authored cycles. Gen-time cycle detection (per resolution path) catches new cycles introduced after audit (e.g., if categories could be edited — but they can't in our design). Worth keeping the gen-time check as defense-in-depth?

   Recommendation: **yes, keep gen-time cycle detection** despite it being theoretically redundant. Cheap, robust against future schema changes.

4. **Resolver implementation — port or write?** Dynamic Prompts has open-source implementations (the [dynamicprompts](https://github.com/adieyal/dynamicprompts) Python lib is the reference). Options:
   - Port the algorithm to TypeScript ourselves — full control, no external dep.
   - Run a small subprocess of the Python lib — guaranteed compatibility but ops overhead.
   - Use a TS port if one exists — saves time but might lag the reference.

   Recommendation: **port to TS ourselves**. The grammar is simple enough (alternation, weights, multi-pick, nested refs) and we want the resolver in our generation pipeline without subprocess hops.

5. **Nested-ref parsing for the audit dependency graph.** At audit time, we need to extract `#refs` from each category's values to build the dependency graph. Two approaches:
   - Regex over the JSONB strings at audit time — straightforward, parse-on-demand.
   - Cache parsed refs as a separate column (e.g., `parsedRefs Json`) populated at import — faster audit, more storage.

   Recommendation: **regex at audit time** for v1. Audit isn't latency-sensitive; categories are small. Add cached-refs column only if we measure a problem.

6. **Step metadata depth.** The example in Diagram 3 shows full nested expansion captured in step metadata. Useful for reproduction and debugging, but JSONB grows with depth. Cap the recorded depth (e.g., only 2–3 levels of nesting in metadata, summarized after that)?

   Recommendation: **record full depth for now**. Expansion trees are bounded by `MAX_DEPTH = 10`, so worst case is 10 levels — bounded and small. Revisit if real wildcard packs produce huge expansion trees.

7. **Cross-set nested refs (v2).** When/if we want shared "core" packs that other packs reference, what's the syntax? Current syntax is bare `#name`. A future qualified syntax might be `#core/hair_color` or `#core::hair_color` — but should we bake compatibility into the v1 parser (just emit a warning, ignore the qualifier) so existing wildcard models that use a qualified syntax don't break on import?

   Recommendation: **yes, parser tolerates qualifiers in v1**. Strip the qualifier and treat as bare ref (within source set scope). When we add cross-set support in v2, the syntax already works.

---

## Quick recap

- One reference syntax: `#name` everywhere — user prompts, stored values, resolver, metadata. Imported wildcard files have `__name__` rewritten to `#name` at import.
- Resolution is recursive, scoped to the source set, depth-limited, cycle-protected.
- Audit walks the dependency graph in topological order, propagating `nsfwLevel` upward but **not** propagating Dirty status (parent's literal content is what's audited; resolution skips dirty branches at gen time).
- The resolver is the same module that handles `{a|b}` alternation — they're sibling Dynamic Prompts features, expanded together.
- Cross-set nesting is v2.
