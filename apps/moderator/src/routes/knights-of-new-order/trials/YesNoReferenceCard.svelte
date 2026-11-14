<script lang="ts">
  import { enhance } from '$app/forms';
  import * as AlertDialog from '@civitai/ui/components/ui/alert-dialog/index.js';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { imageLookupUrl } from '$lib/entity-url';
  import { FormState } from '$lib/form-state.svelte';
  import { LINK_CLASS } from '$lib/format';
  import { YESNO_PROMPT_MAX } from '$lib/knights/trials-limits';
  import YesNoPicker from './YesNoPicker.svelte';
  import type { YesNoReferenceItem } from '$lib/server/knights/yesno-reference.service';

  let { item }: { item: YesNoReferenceItem } = $props();

  const toggle = new FormState({ reload: true, onSuccess: null });
  const save = new FormState({
    reload: true,
    reset: false,
    onSuccess: () => {
      answer = null;
      why = null;
      ask = null;
      toast.success('Saved');
    },
  });
  const remove = new FormState({ reload: true, onSuccess: () => toast.success('Deleted') });
  let answer = $state<'yes' | 'no' | null>(null);
  let why = $state<string | null>(null);
  let ask = $state<string | null>(null);
  const chosen = $derived(answer ?? (item.answer ? 'yes' : 'no'));
  let open = $state(false);
  let deleteForm: HTMLFormElement | undefined = $state();
</script>

<article
  class="flex flex-col gap-4 rounded-xl border border-dark-4 bg-dark-6 p-5 md:flex-row {item.active
    ? ''
    : 'opacity-60'}"
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
      <Badge variant={item.answer ? 'default' : 'secondary'}>Answer: {item.answer ? 'Yes' : 'No'}</Badge>
      <span class="text-sm text-dark-2">{item.answers} answered</span>
      {#if !item.active}<Badge variant="outline">Inactive</Badge>{/if}
      {#if !item.prompt}<Badge variant="outline">No question text</Badge>{/if}
    </div>
    {#if item.prompt}
      <p class="text-sm text-dark-0">{item.prompt}</p>
    {:else}
      <p class="text-sm text-dark-2">
        No question text. Acolytes see the generic prompt: "{item.questionPrompt}".
        {item.answers === 0
          ? 'Edit this pair to write one.'
          : "It can't be edited now that Acolytes have answered it; deactivate it instead."}
      </p>
    {/if}
    <p class="text-xs text-dark-2">{item.questionKey}</p>
    {#if item.answers > 0}
      {#if item.explanation}<p class="text-sm text-dark-2">{item.explanation}</p>{/if}
      <p class="text-xs text-dark-2">
        Acolytes have answered this pair, so it can't be edited or deleted. Deactivate it to stop serving it.
      </p>
    {:else}
      {#if save.error}<ErrorAlert message={save.error} />{/if}
      <form method="POST" action="?/updateYesNo" use:enhance={save.enhance} class="flex flex-col gap-2">
        <input type="hidden" name="id" value={item.id} />
        <Input
          name="prompt"
          required
          maxlength={YESNO_PROMPT_MAX}
          placeholder="The question Acolytes are asked about this image"
          value={ask ?? item.prompt ?? ''}
          oninput={(e) => (ask = e.currentTarget.value)}
        />
        <div class="flex items-center gap-2">
          <span class="text-sm text-dark-2">Answer</span>
          <YesNoPicker value={chosen} onchange={(v) => (answer = v)} />
        </div>
        <Textarea
          name="explanation"
          rows={2}
          placeholder="Why this is the answer, shown to Acolytes after they answer"
          value={why ?? item.explanation ?? ''}
          oninput={(e) => (why = e.currentTarget.value)}
        />
        <div>
          <Button type="submit" size="sm" disabled={save.submitting}>Save</Button>
        </div>
      </form>

    {/if}

    {#if toggle.error}<ErrorAlert message={toggle.error} />{/if}
    {#if remove.error}<ErrorAlert message={remove.error} />{/if}
    <div class="flex flex-wrap gap-2">
      <form method="POST" action="?/toggleYesNo" use:enhance={toggle.enhance}>
        <input type="hidden" name="id" value={item.id} />
        <input type="hidden" name="active" value={String(!item.active)} />
        <Button type="submit" size="sm" variant="outline" disabled={toggle.submitting}
          >{item.active ? 'Deactivate' : 'Activate'}</Button
        >
      </form>
      <form
        bind:this={deleteForm}
        method="POST"
        action="?/deleteYesNo"
        use:enhance={remove.enhance}
      >
        <input type="hidden" name="id" value={item.id} />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={remove.submitting || item.answers > 0}
          onclick={() => (open = true)}>Delete</Button
        >
      </form>
    </div>
  </div>
</article>

<AlertDialog.Root bind:open>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>Delete this pair?</AlertDialog.Title>
      <AlertDialog.Description>
        Image #{item.imageId} is removed from this question's reference answers for good. Deactivate it
        instead to keep it.
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
      <AlertDialog.Action
        variant="destructive"
        onclick={() => {
          open = false;
          deleteForm?.requestSubmit();
        }}>Delete</AlertDialog.Action
      >
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
