<script lang="ts">
  import { num } from '$lib/format';
  import { plural } from './finding-presentation';

  let { counters }: { counters: Record<string, number> } = $props();

  const entries = $derived(Object.entries(counters).sort(([a], [b]) => a.localeCompare(b)));
</script>

{#if entries.length > 0}
  <!-- 🔴 COLLAPSED, BECAUSE THE FINDINGS ARE WHAT THE PAGE IS FOR. A producer may report any number
       of counters and one of them reports around forty — roughly a screen of label/value pairs
       between the run summary and the first finding, so a moderator opening a run scrolled past the
       instrumentation to reach the work. The prose summary above stays open: it is the one thing
       here that reads as a sentence, and it is what moderators use. -->
  <details class="border-dark-4 bg-dark-6 mb-6 rounded-xl border px-5 py-3">
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
