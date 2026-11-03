<script lang="ts">
  import { enhance } from '$app/forms';
  import * as AlertDialog from '@civitai/ui/components/ui/alert-dialog/index.js';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { imageLookupUrl } from '$lib/entity-url';
  import { FormState } from '$lib/form-state.svelte';
  import { LINK_CLASS } from '$lib/format';
  import type { YesNoReferenceItem } from '$lib/server/knights/yesno-reference.service';

  let { item }: { item: YesNoReferenceItem } = $props();

  const toggle = new FormState({ reload: true, onSuccess: null });
  const remove = new FormState({ reload: true, onSuccess: () => toast.success('Deleted') });
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
      {#if !item.active}<Badge variant="outline">Inactive</Badge>{/if}
    </div>
    <p class="text-sm">{item.questionPrompt}</p>
    <p class="text-xs text-dark-2">{item.questionKey}</p>
    {#if item.explanation}<p class="text-sm text-dark-2">{item.explanation}</p>{/if}

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
          disabled={remove.submitting}
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
