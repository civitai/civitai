<script lang="ts">
  import { page } from '$app/state';
  import { IconX } from '@tabler/icons-svelte';

  let { ownerId, username }: { ownerId: number; username: string | null } = $props();

  const cleared = $derived.by(() => {
    const url = new URL(page.url);
    for (const key of ['owner', 'page', 'selected']) url.searchParams.delete(key);
    return `${url.pathname}${url.search}`;
  });
</script>

<a
  href={cleared}
  class="inline-flex w-fit items-center gap-1 rounded-full border border-blue-500/40 bg-blue-500/15 px-2.5 py-0.5 text-xs font-medium text-blue-200 hover:bg-blue-500/25"
  title="Show every owner"
>
  Owner: {username ?? `User #${ownerId}`}
  <IconX size={12} aria-hidden="true" />
</a>
