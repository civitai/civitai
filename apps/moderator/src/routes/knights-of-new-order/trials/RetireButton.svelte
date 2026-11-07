<script lang="ts">
  import { enhance } from '$app/forms';
  import * as AlertDialog from '@civitai/ui/components/ui/alert-dialog/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { FormState } from '$lib/form-state.svelte';

  let { id, imageId, core }: { id: number; imageId: number; core: boolean } = $props();

  const retire = new FormState({ reload: true, onSuccess: () => toast.success('Retired') });
  let open = $state(false);
  let form: HTMLFormElement | undefined = $state();
</script>

{#if retire.error}<ErrorAlert message={retire.error} />{/if}
<form bind:this={form} method="POST" action="?/retire" use:enhance={retire.enhance}>
  <input type="hidden" name="id" value={id} />
  <Button type="button" size="sm" variant="outline" disabled={retire.submitting} onclick={() => (open = true)}
    >Retire</Button
  >
</form>

<AlertDialog.Root bind:open>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>Retire image #{imageId}?</AlertDialog.Title>
      <AlertDialog.Description>
        Acolytes stop seeing it right away.{core ? ' It stays listed here and can be added back.' : ''}
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
      <AlertDialog.Action
        variant="destructive"
        onclick={() => {
          open = false;
          form?.requestSubmit();
        }}>Retire</AlertDialog.Action
      >
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
