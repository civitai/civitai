<script lang="ts">
  import ImageQueuePage from '$lib/components/image-queue/ImageQueuePage.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<ImageQueuePage {data} {form} />
