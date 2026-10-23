<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import {
    BLOCK_REASONS,
    REASON_COMMENT_MAX,
    REASON_NEEDING_COMMENT,
    type BlockReason,
  } from '$lib/scan-labels';

  let {
    token,
    submitting,
    onsubmit,
  }: { token: string; submitting: boolean; onsubmit: SubmitFunction } = $props();

  // Mounted per item (the parent keys it), so none of this carries over to the next image.
  let picking = $state(false);
  let commenting = $state(false);
  let comment = $state('');
  let form = $state<HTMLFormElement | null>(null);

  const submitWith = (selector: string) => {
    if (!form || submitting) return;
    form.requestSubmit(form.querySelector<HTMLButtonElement>(selector));
  };

  const choose = (id: BlockReason) => {
    if (id === REASON_NEEDING_COMMENT) commenting = true;
    else submitWith(`button[name="reason"][value="${id}"]`);
  };

  const onKeydown = (e: KeyboardEvent) => {
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape' && picking) {
      picking = false;
      commenting = false;
      return;
    }
    const target = e.target as HTMLElement | null;
    if (target?.closest('input, textarea, select, [role="combobox"], [role="listbox"]')) return;
    if (!picking) {
      if (e.key === 'b' || e.key === 'B') picking = true;
      else if (e.key === 'n' || e.key === 'N') submitWith('button[name="block"][value="0"]');
      return;
    }
    const index = Number(e.key) - 1;
    if (Number.isInteger(index) && index >= 0 && index < BLOCK_REASONS.length) {
      e.preventDefault();
      choose(BLOCK_REASONS[index].id);
    }
  };
</script>

<svelte:window onkeydown={onKeydown} />

<form method="POST" action="?/vote" use:enhance={onsubmit} bind:this={form} class="flex flex-col gap-3">
  <input type="hidden" name="token" value={token} />
  {#if !picking}
    <div class="grid grid-cols-2 gap-3">
      <Button
        type="button"
        variant="destructive"
        size="lg"
        disabled={submitting}
        onclick={() => (picking = true)}
      >
        Block <span class="ml-2 text-xs opacity-70">B</span>
      </Button>
      <Button
        type="submit"
        name="block"
        value="0"
        variant="secondary"
        size="lg"
        disabled={submitting}
      >
        Don’t block <span class="ml-2 text-xs opacity-70">N</span>
      </Button>
    </div>
  {:else}
    <input type="hidden" name="block" value="1" />
    <div class="flex items-center justify-between">
      <p class="text-sm text-dark-0">Why block it?</p>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onclick={() => {
          picking = false;
          commenting = false;
        }}
      >
        Cancel <span class="ml-2 text-xs opacity-70">Esc</span>
      </Button>
    </div>
    <div class="grid gap-2 sm:grid-cols-2">
      {#each BLOCK_REASONS as reason, i (reason.id)}
        <Button
          type={reason.id === REASON_NEEDING_COMMENT ? 'button' : 'submit'}
          name={reason.id === REASON_NEEDING_COMMENT ? undefined : 'reason'}
          value={reason.id === REASON_NEEDING_COMMENT ? undefined : reason.id}
          variant="outline"
          disabled={submitting}
          class="h-auto flex-col items-start gap-1 whitespace-normal py-2 text-left"
          onclick={reason.id === REASON_NEEDING_COMMENT ? () => (commenting = true) : undefined}
        >
          <span class="text-sm text-dark-0">
            <span class="mr-2 text-xs text-dark-2">{i + 1}</span>{reason.label}
          </span>
          <span class="text-xs font-normal text-dark-2">{reason.help}</span>
        </Button>
      {/each}
    </div>
    {#if commenting}
      <div class="flex flex-col gap-2">
        <Textarea
          name="reasonComment"
          bind:value={comment}
          maxlength={REASON_COMMENT_MAX}
          placeholder="Which rule, briefly"
          autofocus
        />
        <Button
          type="submit"
          name="reason"
          value={REASON_NEEDING_COMMENT}
          variant="destructive"
          disabled={submitting || !comment.trim()}
        >
          Block as other ToS violation
        </Button>
      </div>
    {/if}
  {/if}
</form>
