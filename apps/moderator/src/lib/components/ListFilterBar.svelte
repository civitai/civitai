<script lang="ts">
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';

  export type FilterField =
    | { kind: 'select'; key: string; label: string; options: [string, string][] }
    | { kind: 'search'; key: string; label: string };

  let {
    fields,
    values = $bindable({}),
    matched,
    total,
  }: {
    fields: FilterField[];
    values?: Record<string, string>;
    /** Shown as "N of M" so a filtered-to-nothing list never reads as an empty account. */
    matched: number;
    total: number;
  } = $props();

  const active = $derived(Object.values(values).some((v) => v));
  const labelFor = (f: FilterField & { kind: 'select' }) =>
    f.options.find(([v]) => v === values[f.key])?.[1] ?? f.label;
</script>

<div class="mb-3 flex flex-wrap items-end gap-x-3 gap-y-2">
  {#each fields as f (f.key)}
    {#if f.kind === 'select'}
      <div>
        <Label for="flt-{f.key}" class="text-xs text-dark-2">{f.label}</Label>
        <Select.Root type="single" bind:value={values[f.key]}>
          <Select.Trigger id="flt-{f.key}" class="mt-1 w-36">{labelFor(f)}</Select.Trigger>
          <Select.Content>
            <Select.Item value="">{f.label} — any</Select.Item>
            {#each f.options as [value, label] (value)}
              <Select.Item {value}>{label}</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
      </div>
    {:else}
      <div>
        <Label for="flt-{f.key}" class="text-xs text-dark-2">{f.label}</Label>
        <Input id="flt-{f.key}" bind:value={values[f.key]} class="mt-1 w-52" />
      </div>
    {/if}
  {/each}

  {#if active}
    <Button size="sm" variant="outline" onclick={() => (values = {})}>Clear</Button>
  {/if}

  <span class="pb-1.5 text-xs text-dark-2">
    {matched} of {total}
  </span>
</div>
