<script lang="ts">
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';

  let {
    id,
    label,
    value,
    options,
    onchange,
  }: {
    id: string;
    label: string;
    value: number;
    options: { id: number; label: string }[];
    onchange: (id: number) => void;
  } = $props();

  const chosen = $derived(options.find((option) => option.id === value));
</script>

<div>
  <Label for={id} class="text-xs text-dark-2">{label}</Label>
  <Select.Root type="single" bind:value={() => String(value), (v) => onchange(Number(v))}>
    <Select.Trigger {id} class="mt-1 h-8 w-64">{chosen?.label ?? '—'}</Select.Trigger>
    <Select.Content>
      {#each options as option (option.id)}
        <Select.Item value={String(option.id)}>{option.label}</Select.Item>
      {/each}
    </Select.Content>
  </Select.Root>
</div>
