<script lang="ts">
  import TriagePageHeader from '$lib/components/triage/TriagePageHeader.svelte';
  import CsamHoldTriage from './CsamHoldTriage.svelte';
  import { onMount } from 'svelte';
  import { imageReveal } from '$lib/csam-holds/image-reveal.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  // After mount, never during render: the server rendered blurred and cannot see this moderator's choice.
  onMount(() => {
    if (data.user) imageReveal.restore(data.user.id);
  });
</script>

<div class="flex flex-col lg:h-svh">
  <TriagePageHeader
    title="CSAM holds"
    subtitle="Text the scan held for possible CSAM. Nothing happens to the content or its author until you decide."
    placeholder="Username, user ID or content ID"
    searchLabel="Search holds"
  />
  <div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
    <CsamHoldTriage
      {data}
      {form}
      canDecide={data.grants['csam.report.file'] === true}
      canStrike={data.grants['user.strike'] === true}
      canBan={data.grants['user.ban'] === true}
    />
  </div>
</div>
