<script lang="ts">
  import HeldMedia from '$lib/components/image-queue/HeldMedia.svelte';
  import { shown } from '$lib/held-media-shown';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const recordOpened = () =>
    void fetch(`/api/held-media/${data.item.id}/opened`, { method: 'POST', keepalive: true }).catch(
      () => null
    );
</script>

<svelte:head><title>Media #{data.item.id}</title></svelte:head>

{#key data.item.id}
  <div
    class="flex justify-center"
    use:shown={{ video: data.item.type === 'video', onshown: recordOpened }}
  >
    <HeldMedia item={data.item} class="max-h-[90vh] max-w-full object-contain" controls />
  </div>
{/key}
