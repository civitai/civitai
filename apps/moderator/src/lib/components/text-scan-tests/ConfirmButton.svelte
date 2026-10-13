<script lang="ts">
  import * as AlertDialog from '@civitai/ui/components/ui/alert-dialog/index.js';
  import { Button, type ButtonSize } from '@civitai/ui/components/ui/button/index.js';

  // Place it inside the form it submits.
  let {
    label,
    title,
    description,
    disabled = false,
    size = 'sm',
  }: {
    label: string;
    title: string;
    description: string;
    disabled?: boolean;
    size?: ButtonSize;
  } = $props();

  let form = $state<HTMLFormElement | null>(null);

  const ask = (e: MouseEvent) => (form = (e.currentTarget as HTMLButtonElement).form);

  function confirm() {
    const target = form;
    form = null;
    target?.requestSubmit();
  }
</script>

<Button type="button" {size} variant="ghost" {disabled} onclick={ask}>{label}</Button>
<AlertDialog.Root bind:open={() => form !== null, (open) => !open && (form = null)}>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>{title}</AlertDialog.Title>
      <AlertDialog.Description>{description}</AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
      <AlertDialog.Action variant="destructive" onclick={confirm}>{label}</AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
