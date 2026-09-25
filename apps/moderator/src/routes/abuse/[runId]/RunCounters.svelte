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
       instrumentation to reach the work. The prose summary above stays open: it is the one thing
       here that reads as a sentence, and it is what moderators use.

       Native `<details>` rather than the `Collapsible` primitive: `@civitai/ui`'s `theme.css` styles
       `summary` (the pointer cursor included, so do not add `cursor-pointer` here), nothing outside
       this component needs to drive the open state, and seven other panels in this app already do
       it this way. -->
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
