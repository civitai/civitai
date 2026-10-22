<script lang="ts">
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { num } from '$lib/format';
  import type { ActionData, PageData } from './$types';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const counted = $derived(form && 'counted' in form ? form.counted : null);
</script>

<header class="page-header">
  <h1>Release held CSAM review flags</h1>
  <p>
    Clears the review flag from one user's removed images when the only hold on them is
    {data.releasableLegs.join(', ')}, under an approval. Any other hold refuses. Count first, then
    type the count you were given to release.
  </p>
</header>

{#if form?.error}
  <ErrorAlert class="mb-4" message={form.error} />
{:else if form && 'released' in form}
  <div
    class="mb-4 rounded-md border border-green-500/30 bg-green-500/10 p-2 text-sm text-green-200"
    role="status"
  >
    {form.released}
  </div>
{/if}

<section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
  <form method="POST" action="?/count" use:enhance class="grid max-w-xl gap-3">
    <label class="grid gap-1 text-sm">
      User id
      <Input name="userId" inputmode="numeric" required value={counted?.userId ?? ''} />
    </label>
    <label class="grid gap-1 text-sm">
      Approval reference
      <Input name="approvalRef" required class="font-mono" value={counted?.approvalRef ?? ''} />
    </label>
    <label class="grid gap-1 text-sm">
      Reason
      <Input name="reason" required value={counted?.reason ?? ''} />
    </label>
    <label class="grid gap-1 text-sm">
      Expected count (needed to release)
      <Input name="expectedCount" inputmode="numeric" />
    </label>
    <div class="flex flex-wrap gap-2">
      <Button type="submit" variant="outline">Count</Button>
      <Button type="submit" formaction="?/release" variant="destructive">Release</Button>
    </div>
  </form>

  {#if counted}
    <p class="mt-4 text-sm" role="status">
      User #{counted.userId}: {num(counted.count)} removed image{counted.count === 1 ? '' : 's'} would
      be released. Held by: {counted.legs.join(', ')}. Nothing was changed.
    </p>
  {/if}
</section>
