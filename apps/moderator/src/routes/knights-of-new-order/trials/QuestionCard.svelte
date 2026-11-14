<script lang="ts">
  import { enhance } from '$app/forms';
  import * as AlertDialog from '@civitai/ui/components/ui/alert-dialog/index.js';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { imageLookupUrl } from '$lib/entity-url';
  import { FormState } from '$lib/form-state.svelte';
  import { LINK_CLASS } from '$lib/format';
  import { NOTE_MAX, YESNO_PROMPT_MAX } from '$lib/knights/trials-limits';
  import type { YesNoQuestionItem } from '$lib/server/knights/yesno-question.service';

  let { item }: { item: YesNoQuestionItem } = $props();

  const isOpen = $derived(item.status === 'Open');
  const pending = $derived(
    item.voteCount === 0
      ? 'Nobody has answered it yet.'
      : `Of its ${item.voteCount} ${item.voteCount === 1 ? 'answer' : 'answers'}, any still pending become inconclusive and earn no gold; answers already given stay recorded as data.`
  );

  type Mode = 'retire' | 'reword' | null;
  let mode = $state<Mode>(null);
  let confirming = $state<Mode>(null);
  let note = $state('');
  let ask = $state<string | null>(null);
  let retireForm: HTMLFormElement | undefined = $state();
  let rewordForm: HTMLFormElement | undefined = $state();

  const retire = new FormState({
    reload: true,
    reset: false,
    onSuccess: () => finish('Question retired'),
  });
  const reword = new FormState({
    reload: true,
    reset: false,
    onSuccess: () => finish('Question reworded'),
  });
  const restore = new FormState({ reload: true, onSuccess: () => toast.success('Question restored') });

  function close() {
    mode = null;
    note = '';
    ask = null;
    retire.error = null;
    reword.error = null;
  }
  function finish(message: string) {
    close();
    toast.success(message);
  }
  function confirmed() {
    const form = confirming === 'retire' ? retireForm : rewordForm;
    confirming = null;
    form?.requestSubmit();
  }
</script>

<article
  class="flex flex-col gap-4 rounded-xl border border-dark-4 bg-dark-6 p-5 md:flex-row {isOpen
    ? ''
    : 'opacity-70'}"
  data-testid="question-card"
>
  <a href={imageLookupUrl(item.imageId)} class="shrink-0 self-start">
    <EdgeMedia
      src={item.imageKey}
      name={item.imageName}
      width={240}
      alt="Image {item.imageId}"
      class="max-h-64 rounded-md"
    />
  </a>

  <div class="flex min-w-0 flex-1 flex-col gap-2">
    <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <a href={imageLookupUrl(item.imageId)} class="font-medium {LINK_CLASS}">Image #{item.imageId}</a>
      <Badge variant={isOpen ? 'default' : 'secondary'}>{item.status}</Badge>
      {#if item.reason}<Badge variant="outline">{item.reason}</Badge>{/if}
      <span class="text-sm text-dark-2">{item.voteCount} answered</span>
    </div>
    <p class="text-sm text-dark-0">{item.prompt}</p>
    <p class="text-xs text-dark-2">
      {item.questionKey}{item.externalId ? ` · ${item.externalId}` : ''}
      {#if item.rewordOf}· reworded from {item.rewordOf}{/if}
    </p>
    {#if item.moderation}
      <p class="text-xs text-dark-2">
        Moderator #{item.moderation.by} {item.moderation.action}: {item.moderation.note || 'no note'}
      </p>
    {/if}

    {#if restore.error}<ErrorAlert message={restore.error} />{/if}

    {#if mode === 'retire'}
      {#if retire.error}<ErrorAlert message={retire.error} />{/if}
      <form
        bind:this={retireForm}
        method="POST"
        action="?/retireQuestion"
        use:enhance={retire.enhance}
        class="flex flex-col gap-2"
      >
        <input type="hidden" name="id" value={item.id} />
        <label class="flex flex-col gap-1 text-xs text-dark-2">
          Why retire it?
          <Textarea
            name="note"
            rows={2}
            required
            maxlength={NOTE_MAX}
            placeholder="e.g. the watermark is illegible"
            bind:value={note}
          />
        </label>
        <p class="text-xs text-dark-2">
          Players stop seeing it. Answers already given are kept as data; pending ones become
          inconclusive and earn no gold.
        </p>
        <div class="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant="destructive"
            disabled={retire.submitting || !note.trim()}
            onclick={() => (confirming = 'retire')}>Retire</Button
          >
          <Button type="button" size="sm" variant="ghost" onclick={close}>Cancel</Button>
        </div>
      </form>
    {:else if mode === 'reword'}
      {#if reword.error}<ErrorAlert message={reword.error} />{/if}
      <form
        bind:this={rewordForm}
        method="POST"
        action="?/rewordQuestion"
        use:enhance={reword.enhance}
        class="flex flex-col gap-2"
      >
        <input type="hidden" name="id" value={item.id} />
        <label class="flex flex-col gap-1 text-xs text-dark-2">
          New question
          <Textarea
            name="prompt"
            rows={2}
            required
            maxlength={YESNO_PROMPT_MAX}
            value={ask ?? item.prompt}
            oninput={(e) => (ask = e.currentTarget.value)}
          />
        </label>
        <label class="flex flex-col gap-1 text-xs text-dark-2">
          Why reword it?
          <Textarea name="note" rows={2} required maxlength={NOTE_MAX} bind:value={note} />
        </label>
        <p class="text-xs text-dark-2">
          This question is retired and a new one with the new words opens for the same image. Answers
          already given stay with this one.
        </p>
        <div class="flex gap-2">
          <Button
            type="button"
            size="sm"
            disabled={reword.submitting || !note.trim()}
            onclick={() => (confirming = 'reword')}>Reword</Button
          >
          <Button type="button" size="sm" variant="ghost" onclick={close}>Cancel</Button>
        </div>
      </form>
    {:else}
      <div class="flex flex-wrap gap-2">
        {#if isOpen}
          <Button size="sm" variant="outline" onclick={() => (mode = 'reword')}>Reword</Button>
          <Button size="sm" variant="outline" onclick={() => (mode = 'retire')}>Retire</Button>
        {:else if item.replacedBy}
          <span class="text-xs text-dark-2">Replaced by {item.replacedBy}</span>
        {:else if item.retired}
          <form method="POST" action="?/unretireQuestion" use:enhance={restore.enhance}>
            <input type="hidden" name="id" value={item.id} />
            <Button
              type="submit"
              size="sm"
              variant="outline"
              disabled={restore.submitting || item.voteCount > 0}
              title={item.voteCount > 0 ? 'Players answered it, so it stays retired' : undefined}
              >Restore</Button
            >
          </form>
        {/if}
      </div>
    {/if}
  </div>
</article>

<AlertDialog.Root bind:open={() => confirming !== null, (open) => !open && (confirming = null)}>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title
        >{confirming === 'reword' ? 'Reword this question?' : 'Retire this question?'}</AlertDialog.Title
      >
      <AlertDialog.Description>
        {#if confirming === 'reword'}
          This question is retired and a new one with the new words replaces it for image #{item.imageId}.
        {:else}
          Players stop seeing this question for image #{item.imageId}.
        {/if}
        {pending}
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
      <AlertDialog.Action variant="destructive" onclick={confirmed}
        >{confirming === 'reword' ? 'Reword' : 'Retire'}</AlertDialog.Action
      >
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
