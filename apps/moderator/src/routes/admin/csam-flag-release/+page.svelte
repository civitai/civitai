<script lang="ts">
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import type { ActionData, PageData } from './$types';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const counted = $derived(form && 'counted' in form ? form.counted : null);
  type Typed = { userId: number | string; approvalRef: string; reason: string };
  const typed: Typed | null = $derived(
    counted ?? (form && 'refill' in form ? (form.refill as Typed) : null)
  );
  // Editing a field after the count would leave the release acting on the values counted, not shown.
  let edited = $state(false);
  let releasing = $state(false);
</script>

<header class="page-header">
  <h1>Release held CSAM review flags</h1>
  <p>
    Clears the review flag from one user's removed images when the only hold on them is
    {data.releasableLegs.join(', ')}, under an approval. Any other hold refuses. Count first; the
    release form appears with the number to type.
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
  <form
    method="POST"
    action="?/count"
    use:enhance={() =>
      async ({ update }) => {
        await update({ reset: false });
        edited = false;
      }}
    oninput={() => (edited = true)}
    class="grid max-w-xl gap-3"
  >
    <label class="grid gap-1 text-sm">
      User id
      <Input name="userId" inputmode="numeric" required value={typed?.userId ?? ''} />
    </label>
    <label class="grid gap-1 text-sm">
      Approval reference
      <Input name="approvalRef" required class="font-mono" value={typed?.approvalRef ?? ''} />
    </label>
    <label class="grid gap-1 text-sm">
      Reason
      <Input name="reason" required value={typed?.reason ?? ''} />
    </label>
    <div>
      <Button type="submit" variant="outline">Count</Button>
    </div>
  </form>

  <!-- Its own form, so Enter in the count field submits Release and never Count. -->
  {#if counted && !edited}
    <form
      method="POST"
      action="?/release"
      use:enhance={({ cancel }) => {
        if (releasing) return cancel();
        releasing = true;
        return async ({ update }) => {
          await update();
          releasing = false;
        };
      }}
      class="mt-4 grid max-w-xl gap-3 rounded-md border border-yellow-500/40 bg-yellow-500/10 p-3"
    >
      <p class="text-sm font-semibold text-yellow-200" role="status">
        Count only, NOTHING RELEASED YET. User #{counted.userId}: {counted.count} removed
        {counted.count === 1 ? 'image' : 'images'} would be released. Held by:
        {counted.legs.join(', ')}. To release, type {counted.count} below and press Release.
      </p>
      <input type="hidden" name="userId" value={counted.userId} />
      <input type="hidden" name="approvalRef" value={counted.approvalRef} />
      <input type="hidden" name="reason" value={counted.reason} />
      <label class="grid gap-1 text-sm">
        Count to release
        <Input name="expectedCount" inputmode="numeric" autocomplete="off" required />
      </label>
      <div>
        <Button type="submit" variant="destructive" disabled={releasing}>Release</Button>
      </div>
    </form>
  {/if}
</section>
