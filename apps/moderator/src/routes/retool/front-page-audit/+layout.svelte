<script lang="ts">
  import { page } from '$app/state';
  import { cn } from '@civitai/ui/utils.js';
  import { MEDIA_LABELS, SWEEP_MEDIA } from './sweep';

  let { children }: { children: import('svelte').Snippet } = $props();

  const current = $derived(page.params.media);
</script>

<header class="page-header">
  <h1>Front Page Audit</h1>
  <p>
    Sweep newly scanned content carrying one rating and correct what is wrong. Unlike the ratings
    queue, nothing here was reported — this is the patrol.
  </p>
</header>

<!-- Tabs rather than a filter: the two sweeps are different populations under different rules, and
     each keeps its own resume point. A dropdown would say they were one query, filtered. -->
<nav class="mb-4 flex flex-wrap gap-1 border-b border-dark-4">
  {#each SWEEP_MEDIA as media (media)}
    <a
      href="/retool/front-page-audit/{media}"
      class={cn(
        '-mb-px border-b-2 px-3 py-2 text-sm',
        current === media
          ? 'border-blue-500 text-white'
          : 'border-transparent text-dark-2 hover:text-dark-0'
      )}
    >
      {MEDIA_LABELS[media]}
    </a>
  {/each}
</nav>

{@render children()}
