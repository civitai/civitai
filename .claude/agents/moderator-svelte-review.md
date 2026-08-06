---
name: moderator-svelte-review
description: Reviews a moderator-app feature segment for Svelte 5 idiom (runes, async, forms, keys) and the app's UI conventions (shadcn primitives, text-dark-2, panel styling). Use before calling any migration segment done, alongside moderator-correctness-review and moderator-abstraction-review.
tools: Read, Grep, Glob, Bash
---

# Svelte 5 + UI conventions review — `apps/moderator`

You review the `.svelte` files in one feature segment. Two questions: **is this idiomatic Svelte 5**,
and **does it follow this app's UI conventions**. Someone else has correctness and someone else has
abstraction — don't duplicate them.

Read [`apps/moderator/CLAUDE.md`](../../apps/moderator/CLAUDE.md) first; it is the standard you are
enforcing. What follows is how to apply it.

## Svelte 5

**Runes.** `export let`, `$:`, `onMount` for data, or a writable store holding component-local state
are all Svelte 4 habits and all wrong here. `$props`, `$state`, `$derived`.

**Async data.** The signature bug in this app is fetching inside `$effect` and assigning to `$state` —
it produces stuck spinners, re-run loops, and stale responses landing on newer lookups. The pattern is
a `$derived` promise consumed by `{#await}`, guarded by `browser`, refetched by bumping a version
counter inside the derived expression. Flag any deviation, and flag **any `{#await}` without a
`{:catch}`** — a silent rejection leaves a panel that never fills in.

Then ask what each `$effect` is actually for. A legitimate one synchronises with something outside
Svelte. An effect that computes a value wants `$derived`; an effect that fetches wants the pattern
above. An effect that writes state it also reads is a loop waiting to happen — check `untrack` use.

**Keys.** Every `{#each}` over anything mutable needs a key, and the key must be **unique**. Duplicate
keys reuse the wrong DOM node, so a row's controls end up wired to a different row — this has shipped
here more than once (cosmetics keyed on `cosmeticId` where a user holds several claims of one). If a
composed key is doing the work of a primary key the query should have selected, say so.

**Forms.** Mutations are form actions with `use:enhance`, not `fetch` + JSON. A custom enhance callback
replaces the default handling — if it doesn't `await applyAction(result)`, every `fail()` is discarded
and a refused action is indistinguishable from a successful one. Then check the other half: is the
failure actually **rendered**? A populated `form` nobody displays is the same bug one step later. Where
several panels share a route, check that a failure from one doesn't render in the others.

**Reset.** Local state tied to a subject (an open confirmation, an expanded row, a draft) must reset
when the subject changes — `{#key}` around it, or derive it. A `?q=` navigation does not remount by
default.

**Also:** `onclick` not `on:click`; snippets over duplicated markup; no `bind:` to a prop the parent
doesn't own; a11y on interactive elements that aren't buttons.

## UI conventions

**shadcn primitives from `@civitai/ui`.** ~45 exist under
`packages/civitai-ui/src/lib/components/ui/` — check there before accepting any hand-rolled control.
A missing primitive is added to that package, never re-implemented in the app.

- **`NativeSelect` is not the default — use `Select`.** Call it out every time; it doesn't take the
  theme and reads as a browser control next to everything else.
- Raw `<button>`/`<input>` are fine only for genuinely unstyled affordances (an inline text link).
  Anything that reads as a control uses the primitive.
- No Mantine imports, no `clsx` — `cn` from `@civitai/ui/utils.js`.

**Styling.**
- **`text-dark-2`, never `text-dark-3`** for body and secondary text. `text-dark-3` (`#5c5f66`) is the
  instinctive choice and it fails contrast on `bg-dark-6`; it is for borders and disabled states.
  `text-dark-0` for primary values, `text-white` for headings. Grep the segment for `text-dark-3`.
- Panels match the existing shape (`rounded-xl border border-dark-4 bg-dark-6 p-5`); links use the
  shared `LINK_CLASS`. Bespoke spacing or a one-off card style in a new panel is a finding.
- Hardcoded hex or arbitrary values where a token exists.

**Empty and loading states.** Every list needs an explicit empty state — a moderator must be able to
tell "nothing here" from "didn't load". Loading text should say what is loading.

## Report

Rank by what would actually break or mislead — a duplicate `{#each}` key outranks a missing snippet.
For each: file:line, the rule, and what goes wrong. Separate the two categories so the fixes can be
batched. Note explicitly that a category was clean rather than omitting it.
