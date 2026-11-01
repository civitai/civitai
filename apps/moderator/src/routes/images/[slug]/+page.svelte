<script lang="ts">
  import ImageQueuePage from '$lib/components/image-queue/ImageQueuePage.svelte';
  import CsamUserGroups from '$lib/components/image-queue/CsamUserGroups.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

{#if data.kind === 'csam-users'}
  <CsamUserGroups {data} {form} />
{:else}
  <ImageQueuePage {data} {form} />
{/if}
