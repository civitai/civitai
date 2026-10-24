<script lang="ts">
  import { num, plural } from '$lib/format';

  let { counters }: { counters: Record<string, number> } = $props();

  const entries = $derived(Object.entries(counters).sort(([a], [b]) => a.localeCompare(b)));
</script>

{#if entries.length === 0}
  <!-- Said rather than left blank, for the reason the "Not acted on" badge is spelled out: an absent
       section reads as a feature that is not there, on a page that also has a legitimate "this
       deployment lacks the columns" mode. A run genuinely reporting no counters is ordinary. -->
  <p class="text-dark-2 mb-6 text-sm">This run reported no counters.</p>
{:else}
  <!-- 🔴 COLLAPSED, BECAUSE THE FINDINGS ARE WHAT THE PAGE IS FOR. A producer may report any number
       of counters and one of them reports around forty — roughly a screen of label/value pairs
       between the run summary and the first finding, so a moderator opening a run scrolled past the
       instrumentation to reach the work. ⚠️ The prose summary above is now ALSO collapsed, so this is
       no longer the only toggle on the page: the counters stay shut because they are instrumentation,
       and the summary because it is a wall of prose where the scannable facts belong. What is left
       open is the structured header — detector, timing, these counters' toggle, and the backlog line.

       Native `<details>` rather than the `Collapsible` primitive: `@civitai/ui`'s `theme.css` styles
       `summary` (the pointer cursor included, so do not add `cursor-pointer` here), nothing outside
       this component needs to drive the open state, and it is this app's dominant spelling. ⚠️ The
       instance count that stood here ("seven other panels") was measured wrong and is deleted rather
       than corrected — it moves and nothing checks it. -->
  <details class="border-dark-4 bg-dark-6 mb-6 rounded-xl border p-5">
    <summary class="text-dark-2 text-sm">Run details — {plural(entries.length, 'counter')}</summary>
    <dl class="mt-3 flex flex-wrap gap-x-6 gap-y-1">
      {#each entries as [key, value] (key)}
        <div>
          <dt class="text-dark-2 text-sm">{key}</dt>
          <dd>{num(value)}</dd>
        </div>
      {/each}
    </dl>
  </details>
{/if}
