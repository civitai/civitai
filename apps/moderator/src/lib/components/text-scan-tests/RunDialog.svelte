<script lang="ts">
  import { plural } from '$lib/format';
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import * as Dialog from '@civitai/ui/components/ui/dialog/index.js';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import { FormState } from '$lib/form-state.svelte';
  import type { Quote } from '$lib/server/text-scan-tests/runs';

  let {
    setId,
    prompts,
    label,
    disabled,
    onstarted,
  }: {
    setId: number;
    prompts: string;
    label: string;
    disabled: boolean;
    onstarted: () => void;
  } = $props();

  let open = $state(false);
  let quote = $state<Quote | null>(null);

  const BASELINE_NOTE: Record<Quote['baseline'], (draft: boolean) => string> = {
    reuse: () => 'The baseline is up to date, so only your draft is scanned.',
    'top-up': () => 'The baseline is scanned only for the cases added or changed since it ran.',
    new: (draft) =>
      draft
        ? 'There is no up-to-date baseline, so the live prompts are scanned too.'
        : 'This scans the live prompts to make a new baseline.',
  };

  const quoting = new FormState({
    reset: false,
    onSuccess: (data) => {
      quote = (data?.quote as Quote | undefined) ?? null;
      starting.error = null;
      open = quote !== null;
    },
  });
  const starting = new FormState({
    reset: false,
    onSuccess: () => {
      open = false;
      quote = null;
      toast.success('Run started. It keeps going if you leave this page.');
      onstarted();
    },
  });
</script>

<form method="POST" action="?/quoteRun" use:enhance={quoting.enhance}>
  <input type="hidden" name="setId" value={setId} />
  <input type="hidden" name="prompts" value={prompts} />
    <Button type="submit" size="sm" disabled={disabled || quoting.submitting}>
    {quoting.submitting ? 'Estimating…' : label}
  </Button>
</form>
{#if quoting.error}
  <p class="whitespace-pre-wrap text-sm text-red-300">{quoting.error}</p>
{/if}

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>Start this run?</Dialog.Title>
      <Dialog.Description>It runs in the background; you can leave the page.</Dialog.Description>
    </Dialog.Header>
    {#if quote}
      <p class="text-sm text-dark-0">
        Run {plural(quote.cases, 'case')}: about {plural(quote.calls, 'call')}, about {quote.buzz} Buzz, about
        {quote.minutes} min.
      </p>
      <p class="text-xs text-dark-2">
        {BASELINE_NOTE[quote.baseline](quote.draft)}
        {#if !quote.measured}The price could not be checked, so 1 Buzz a call is assumed.{/if}
      </p>
      <form method="POST" action="?/startRun" use:enhance={starting.enhance} class="space-y-3">
        <input type="hidden" name="setId" value={setId} />
        <input type="hidden" name="prompts" value={prompts} />
                <input type="hidden" name="stamp" value={quote.stamp} />
        {#if starting.error}
          <p class="whitespace-pre-wrap text-sm text-red-300">{starting.error}</p>
        {/if}
        <Dialog.Footer>
          <Button type="button" variant="ghost" onclick={() => (open = false)}>Cancel</Button>
          <Button type="submit" disabled={starting.submitting}>
            {starting.submitting ? 'Starting…' : 'Start run'}
          </Button>
        </Dialog.Footer>
      </form>
    {/if}
  </Dialog.Content>
</Dialog.Root>
