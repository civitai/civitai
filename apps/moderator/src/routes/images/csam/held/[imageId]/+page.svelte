<script lang="ts">
  import HeldMedia from '$lib/components/image-queue/HeldMedia.svelte';
  import { shown } from '$lib/held-media-shown';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  // The image whose open the server did not take, so the notice is never another image's.
  let refusedId = $state<number | null>(null);
  const recordOpened = () => {
    const id = data.item.id;
    void fetch(`/api/held-media/${id}/opened`, { method: 'POST', keepalive: true })
      .then((res) => {
        if (!res.ok) refusedId = id;
        else if (refusedId === id) refusedId = null;
      })
      .catch(() => (refusedId = id));
  };
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
{#if refusedId === data.item.id}
  <p class="mt-2 text-center text-sm text-dark-2">
    This open was not recorded. Reload the page to try again.
  </p>
{/if}
