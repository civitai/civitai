<script lang="ts">
  import { page } from '$app/state';
  import { urlWith } from '$lib/url';
  import AnnouncementPanel from './AnnouncementPanel.svelte';
  import TrainingFilters from './TrainingFilters.svelte';
  import TrainingModelCard from './TrainingModelCard.svelte';
  import CursorPager from '$lib/components/CursorPager.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<header class="page-header">
  <h1>Training Models</h1>
  <p>Models uploaded with training data, for moderation review.</p>
</header>

<AnnouncementPanel announcement={data.announcement} colors={data.announcementColors} />
<TrainingFilters filters={data.filters} />

{#if data.items.length === 0}
  <p class="text-sm text-dark-2">No training models match these filters.</p>
{:else}
  <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
    {#each data.items as model (model.id)}
      <TrainingModelCard
        {model}
        civitaiUrl={data.civitaiUrl}
        canBan={!!data.grants['audit.ban.execute']}
      />
    {/each}
  </div>
{/if}

<CursorPager href={data.nextCursor ? urlWith(page.url, { cursor: data.nextCursor }) : null} />
