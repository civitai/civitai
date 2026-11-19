<script lang="ts">
  import { enhance } from '$app/forms';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { FormState } from '$lib/form-state.svelte';
  import {
    postTextActionAllowed,
    type PostTextAction,
    type ReportedPostText,
  } from '$lib/post-text-report';

  /** A post-queue report's storyline text: refuse, restore, or (CSAM reasons) hold it, with a reason. */
  let {
    reportId,
    reason,
    details,
    text,
    canAct,
    onDone,
  }: {
    reportId: number;
    reason: string;
    details: unknown;
    text: ReportedPostText;
    canAct: boolean;
    /** What the action did, for the page to show: the ruled report leaves this list on the reload. */
    onDone: (message: string) => void;
  } = $props();

  const form = new FormState({
    reload: true,
    onSuccess: (data) => {
      if (typeof data?.textAction === 'string') onDone(data.textAction);
    },
  });

  const offered = $derived(
    (['hold', 'refuse', 'restore'] as const).filter(
      (action) =>
        postTextActionAllowed(action, { reason, details }) &&
        (action === 'restore'
          ? text.refusedByModerator && !text.held
          : action === 'refuse'
            ? !text.refusedByModerator && !text.held
            : !text.held)
    )
  );

  const LABELS: Record<PostTextAction, string> = {
    hold: 'Hold for CSAM review',
    refuse: 'Refuse text',
    restore: 'Restore text',
  };
  const ACTIONS: Record<PostTextAction, string> = {
    hold: '?/holdText',
    refuse: '?/refuseText',
    restore: '?/restoreText',
  };
</script>

<div class="flex flex-col gap-2 rounded-lg border p-2 text-xs">
  <div class="flex flex-wrap items-center gap-1.5">
    <Badge variant="secondary">Text</Badge>
    {#if text.position != null}
      <span class="text-muted-foreground">slide {text.position} of {text.slideCount}</span>
    {/if}
    {#if text.held}
      <Badge variant="destructive">held for CSAM review</Badge>
    {:else if text.refusedByModerator}
      <Badge variant="destructive">refused by a moderator</Badge>
      {#if text.refusedByScan}<Badge variant="destructive">and by the scan</Badge>{/if}
    {:else if text.refused}
      <Badge variant="destructive">refused by the scan</Badge>
    {/if}
  </div>

  <!-- Plain text from the server (`htmlToText`): rendered as text, never as HTML. -->
  {#if text.reportedText != null}
    <p class="m-0 text-muted-foreground">As reported</p>
    <p class="m-0 max-h-64 overflow-auto whitespace-pre-wrap rounded border bg-muted/40 p-2 text-sm">
      {text.reportedText || '(empty)'}
    </p>
  {/if}
  {#if text.text == null}
    <p class="m-0 text-dark-2">The text has since been deleted. Its report can still be ruled on.</p>
  {:else if text.text !== text.reportedText}
    <p class="m-0 text-muted-foreground">{text.reportedText != null ? 'Now reads' : 'Text'}</p>
    <p class="m-0 max-h-64 overflow-auto whitespace-pre-wrap rounded border bg-muted/40 p-2 text-sm">
      {text.text || '(empty)'}
    </p>
  {/if}

  {#if text.held}
    <p class="m-0 text-dark-2">Decided in the CSAM text-hold queue, not here.</p>
  {:else if canAct && text.text != null && offered.length}
    <form method="POST" use:enhance={form.enhance} class="flex flex-col gap-2">
      <input type="hidden" name="id" value={reportId} />
      <Textarea name="reason" rows={2} maxlength={500} required placeholder="Why (kept in the audit log)" />
      <div class="flex flex-wrap gap-2">
        {#each offered as action (action)}
          <Button
            type="submit"
            size="xs"
            variant={action === 'restore' ? 'outline' : 'destructive'}
            formaction={ACTIONS[action]}
            disabled={form.submitting}
          >
            {LABELS[action]}
          </Button>
        {/each}
      </div>
    </form>
  {/if}
  {#if form.error}<p class="m-0 text-red-300" role="alert">{form.error}</p>{/if}
</div>
