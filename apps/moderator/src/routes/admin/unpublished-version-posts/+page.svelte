<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { num } from '$lib/format';
  import type { ActionData } from './$types';

  let { form }: { form: ActionData } = $props();

  const EXCLUSION_LABELS: Record<string, string> = {
    alreadyQueued: 'Already reported by this job',
    noImages: 'No images',
    imageNotClear: 'An image is not scanned or is flagged for the CSAM queue',
    posterBanned: 'Poster is banned',
    posterHeld: 'Poster is under a hold',
  };

  let pending = $state(false);
  // Keep what was typed: a reset after submit would clear the reasons the run form is built from.
  const submit: SubmitFunction = () => {
    pending = true;
    return async ({ update }) => {
      await update({ reset: false });
      pending = false;
    };
  };

  const reasons = $derived(form && 'reasons' in form && form.reasons ? form.reasons : []);
  const plan = $derived(form && 'plan' in form ? form.plan : undefined);
</script>

<header class="page-header">
  <h1>Unpublished version posts</h1>
  <p>
    Puts other users' published posts made with a model version or model a moderator unpublished in
    the post reports queue, one Admin Attention report each, filed by the system account. Nothing on
    the posts or their images changes.
  </p>
</header>

{#if form?.error}
  <ErrorAlert class="mb-4" message={form.error} />
{:else if form?.kind === 'filed'}
  <div
    class="mb-4 rounded-md border border-green-500/30 bg-green-500/10 p-2 text-sm text-green-200"
    role="status"
  >
    Filed {num(form.reported)} reports. Dry-run again: it should show none eligible.
  </div>
{/if}

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h2 class="mb-1 text-sm font-semibold text-white">1. Dry run</h2>
  <p class="mb-3 text-xs text-dark-2">Counts only. Unpublish reason codes, one per line.</p>
  <form method="POST" action="?/dryRun" use:enhance={submit} class="space-y-2">
    <Textarea name="reasons" rows={4} class="font-mono" value={reasons.join('\n')} required />
    <Button type="submit" variant="outline" disabled={pending}>Dry run</Button>
  </form>

  {#if plan}
    <dl class="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      <dt class="font-semibold text-white">Eligible</dt>
      <dd class="font-semibold text-white">{num(plan.eligible)}</dd>
      {#each Object.entries(plan.byReason) as [reason, count] (reason)}
        <dt class="pl-3 font-mono text-dark-2">{reason}</dt>
        <dd>{num(count)}</dd>
      {/each}
      {#each Object.entries(plan.excluded) as [key, count] (key)}
        <dt class="text-dark-2">Skipped: {EXCLUSION_LABELS[key] ?? key}</dt>
        <dd>{num(count)}</dd>
      {/each}
    </dl>
  {/if}
</section>

<section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h2 class="mb-1 text-sm font-semibold text-white">2. Run</h2>
  {#if reasons.length}
    <p class="mb-3 text-xs text-dark-2">
      Files reports for <span class="font-mono">{reasons.join(', ')}</span>. Type the eligible count
      from the dry run; if it has moved, nothing is filed.
    </p>
    <form method="POST" action="?/run" use:enhance={submit} class="flex flex-wrap gap-2">
      <input type="hidden" name="reasons" value={reasons.join('\n')} />
      <Input
        name="expectedCount"
        inputmode="numeric"
        autocomplete="off"
        placeholder="Eligible count"
        class="w-40"
        required
      />
      <Button type="submit" disabled={pending}>Run</Button>
    </form>
  {:else}
    <p class="text-sm text-dark-2">Dry-run first.</p>
  {/if}
</section>
