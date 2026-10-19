<script lang="ts">
  import BoxEditor from './BoxEditor.svelte';
  import ListingPanel from './ListingPanel.svelte';
  import StatusPanel from './StatusPanel.svelte';
  import GrantPanel from './GrantPanel.svelte';
  import { LINK_CLASS } from '$lib/format';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  let dirty = $state(false);
</script>

<header class="page-header">
  <h1>#{data.box.id} {data.draft.name}</h1>
  <span class="flex gap-3 text-sm">
    <a class={LINK_CLASS} href="/items/boxes/{data.box.id}/flow">New builder (preview)</a>
    <a class={LINK_CLASS} href="/items/boxes/{data.box.id}/openings">Openings</a>
  </span>
</header>

<StatusPanel box={data.box} snapshots={data.snapshots} civitaiUrl={data.civitaiUrl} {dirty} />

<!-- Remounts on every write to the box (each stamps updatedAt), so the working copy restarts from the
     rows the server wrote, with their new ids. -->
{#key `${data.box.version}:${data.box.updatedAt}`}
  <BoxEditor
    box={data.box}
    initial={data.draft}
    initialRewards={data.rewards}
    events={data.events}
    bind:dirty
  />
{/key}

<ListingPanel boxStatus={data.box.status} listings={data.listings} />

<!-- A grant id belongs to one box's form: its keys do not name the box. -->
{#key data.box.id}
  <GrantPanel boxStatus={data.box.status} canGrant={!!data.grants['items.boxes.grant']} />
{/key}
