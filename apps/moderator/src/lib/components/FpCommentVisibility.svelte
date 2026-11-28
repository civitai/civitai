<script lang="ts">
  import { enhance } from '$app/forms';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { FormState } from '$lib/form-state.svelte';
  import type { FpCommentState } from '$lib/fp-comment';
  import TipButton from './TipButton.svelte';

  // Posts the seen version and hide so a comment that changed since is refused. The scan's own hide
  // is lifted by its report's Unactioned, so it offers no Unhide.
  let {
    commentId,
    fp,
    action,
    fields = {},
    canAct,
    onchange,
  }: {
    commentId: number;
    fp: FpCommentState;
    /** The form action, e.g. `?/fpVisibility`. */
    action: string;
    /** Further hidden fields the action reads. */
    fields?: Record<string, string | number>;
    canAct: boolean;
    onchange: (state: FpCommentState | null) => void;
  } = $props();

  let message = $state<string | null>(null);
  const form = new FormState({
    reset: false,
    onSuccess: (data) => {
      message = typeof data?.message === 'string' ? data.message : null;
      onchange((data?.fpState as FpCommentState | null | undefined) ?? null);
    },
  });
</script>

<span class="inline-flex flex-wrap items-center gap-2">
  {#if fp.tosViolation}
    <span class="text-xs text-dark-2">Removed as ToS, so it stays hidden.</span>
  {:else if fp.hidden}
    <Badge variant="secondary">{fp.scanHide ? 'Hidden by scan' : 'Hidden'}</Badge>
  {/if}
  {#if canAct && !fp.tosViolation && !(fp.hidden && fp.scanHide)}
    <form method="POST" {action} use:enhance={form.enhance} class="inline">
      <input type="hidden" name="commentId" value={commentId} />
      <input type="hidden" name="hidden" value={fp.hidden ? 'false' : 'true'} />
      <input type="hidden" name="seenVersion" value={fp.version} />
      <input type="hidden" name="seenHiddenAt" value={fp.hiddenAt ?? ''} />
      {#each Object.entries(fields) as [name, value] (name)}
        <input type="hidden" {name} {value} />
      {/each}
      <TipButton
        type="submit"
        size="xs"
        variant="outline"
        disabled={form.submitting}
        tip={fp.hidden
          ? 'Show it again: on the site at once, on the platform after the next daily reconcile.'
          : 'Hide it on the site and the platform. Only a moderator can show it again.'}
      >
        {fp.hidden ? 'Unhide' : 'Hide'}
      </TipButton>
    </form>
  {/if}
  {#if fp.hidden && fp.scanHide}
    <span class="text-xs text-dark-2">Set its scan report to Unactioned to show it again.</span>
  {/if}
  {#if form.error}
    <span class="text-xs text-red-300" role="alert">{form.error}</span>
  {:else if message}
    <span class="text-xs text-dark-2" role="status">{message}</span>
  {/if}
</span>
