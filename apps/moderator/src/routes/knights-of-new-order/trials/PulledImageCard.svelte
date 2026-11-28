<script lang="ts">
  import { enhance } from '$app/forms';
  import * as AlertDialog from '@civitai/ui/components/ui/alert-dialog/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { imageLookupUrl } from '$lib/entity-url';
  import { FormState } from '$lib/form-state.svelte';
  import { LINK_CLASS } from '$lib/format';
  import { reportBreakdown } from '$lib/knights/report-copy';
  import type { OrphanImagePull } from '$lib/server/knights/yesno-question.service';
  import PullFiling from './PullFiling.svelte';
  import TrialMedia from './TrialMedia.svelte';

  let { pull }: { pull: OrphanImagePull & { restricted: boolean } } = $props();

  const returning = new FormState({ reload: true, onSuccess: () => toast.success('Image returned') });
  let open = $state(false);
  let form: HTMLFormElement | undefined = $state();
</script>

<article class="flex flex-col gap-4 rounded-xl border border-dark-4 bg-dark-6 p-5 md:flex-row" data-testid="pulled-image-card">
  <a href={imageLookupUrl(pull.imageId)} class="shrink-0 self-start">
    <TrialMedia item={pull} width={240} alt="Image {pull.imageId}" class="max-h-64 rounded-md" />
  </a>
  <div class="flex min-w-0 flex-1 flex-col gap-2">
    <a href={imageLookupUrl(pull.imageId)} class="font-medium {LINK_CLASS}">Image #{pull.imageId}</a>
    <p class="text-sm text-dark-0">Pulled by: {pull.prompt}</p>
    <p class="text-xs text-dark-2">{reportBreakdown(pull)}</p>
    <p class="text-xs text-dark-2">
      {pull.questionKey} · That question was removed, so the image stays out of Knights questions and Acolyte pairs until
      it is returned.
    </p>
    <p class="flex flex-wrap items-center gap-2 text-xs text-dark-2"><PullFiling {pull} /></p>
    {#if returning.error}<ErrorAlert message={returning.error} />{/if}
    {#if pull.restricted}
      <span class="text-xs text-dark-2">Withheld from you, so it can't be returned here.</span>
    {:else}
      <form bind:this={form} method="POST" action="?/returnImage" use:enhance={returning.enhance}>
        <input type="hidden" name="id" value={pull.id} />
        <Button type="button" size="sm" variant="outline" disabled={returning.submitting} onclick={() => (open = true)}
          >Return image</Button
        >
      </form>
    {/if}
  </div>
</article>

<AlertDialog.Root bind:open>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>Return image #{pull.imageId}?</AlertDialog.Title>
      <AlertDialog.Description>
        Its open questions and Acolyte pairs are served again. Questions on it that closed meanwhile stay closed, and the
        removed question stays removed.
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
      <AlertDialog.Action
        onclick={() => {
          open = false;
          form?.requestSubmit();
        }}>Return image</AlertDialog.Action
      >
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
