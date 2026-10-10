<script lang="ts">
  import type { Snippet } from 'svelte';

  let { label, children }: { label: string; children: Snippet } = $props();
</script>

<!-- A producer's prose, collapsed, with the obligation to read it in the label.
     🔴 THE LABEL IS THE MITIGATION, NOT DECORATION. Collapsing can hide text that decides the ruling —
     some detectors close a reason by warning that the flagged behaviour may be legitimate and telling
     the reader to check the underlying content first — so the caller names what is behind the toggle
     and whether it has to be opened. A label of "Details" would hide a prerequisite behind a shrug.

     🔴 THE PROSE STAYS IN THE CALLER, inside its own wrapping element, rather than being passed as a
     string prop. `apps/moderator/src/routes/abuse/__tests__/prose-wrapping.test.ts` resolves the tag
     each prose field is rendered in and asserts it opts into wrapping; a `text` prop would move both
     fields into one shared tag here, and that guard — which exists because an unwrapped reason
     rendered on one line and painted over the column beside it — would resolve to nothing and pass
     over an empty read.

     Native `<details>` rather than `@civitai/ui`'s `Collapsible`, matching `RunCounters.svelte` beside
     this file and the app's dominant spelling elsewhere: `theme.css` styles `summary`, the pointer
     cursor included (so do not add `cursor-pointer`), nothing outside needs to drive the open state,
     and it works with no JS. ⚠️ No instance count is given on purpose — it moves, nothing checks it,
     and the one that used to be here was wrong.

     🔴 THE OPEN STATE LIVES IN THE DOM, SO THE CALLER OWNS RESETTING IT. A `<details>` does not reset
     when its subject changes, and neither of this component's routes remounts on navigation — so both
     callers wrap it in `{#key <subject id>}` and a third must too. Without that, prose a moderator
     opened on one run or finding stays expanded on the next. -->
<details>
  <summary class="text-dark-2 text-sm">{label}</summary>
  <div class="mt-2">{@render children()}</div>
</details>
