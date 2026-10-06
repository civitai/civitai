<script lang="ts">
  import { num, relativeTime } from '$lib/format';
  import type { PageData } from './$types';

  let { header, overridden }: { header: NonNullable<PageData['header']>; overridden: boolean } =
    $props();
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <p class="text-sm">
    <span class="font-semibold text-white">Support router</span>
    <span class="text-dark-2">
      · version <code>{header.version}</code>{overridden ? ' (pinned by URL)' : ''}
      · {num(header.activeGroups)} active groups of a {num(header.cap)} cap
      · last routed {relativeTime(header.lastRoutedAt)}
    </span>
  </p>
  {#if header.warnings.length}
    <ul class="mt-2 space-y-1">
      {#each header.warnings as w (w)}
        <li class="text-sm text-amber-300">⚠ {w}</li>
      {/each}
    </ul>
  {/if}
</section>
