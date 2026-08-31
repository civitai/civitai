<script lang="ts">
  import type { SubmitFunction } from '@sveltejs/kit';
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Checkbox } from '@civitai/ui/components/ui/checkbox/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { RadioGroup, RadioGroupItem } from '@civitai/ui/components/ui/radio-group/index.js';

  let {
    contents,
    enhancer,
    busy = false,
    onCancel,
  }: {
    contents: Record<string, string>;
    enhancer: SubmitFunction;
    busy?: boolean;
    onCancel: () => void;
  } = $props();

  let minorDepiction = $state('');
  let confirmed = $state(false);
</script>

<form method="POST" action="?/reportCsam" use:enhance={enhancer}>
  <div class="rounded-xl border border-red-500/40 bg-red-500/10 p-5">
    <p class="mb-3 text-sm text-white">
      Filing this report denies the training run, deletes the account, and queues a CyberTipline
      report. It cannot be undone from here.
    </p>

    <fieldset class="mb-4">
      <legend class="mb-2 text-xs tracking-wide text-dark-2 uppercase">Minor depiction</legend>
      <RadioGroup name="minorDepiction" bind:value={minorDepiction} class="flex gap-6">
        <div class="flex items-center gap-2">
          <RadioGroupItem value="real" id="depiction-real" />
          <Label for="depiction-real" class="font-normal text-dark-0">Real</Label>
        </div>
        <div class="flex items-center gap-2">
          <RadioGroupItem value="non-real" id="depiction-non-real" />
          <Label for="depiction-non-real" class="font-normal text-dark-0">Non-real</Label>
        </div>
      </RadioGroup>
    </fieldset>

    <fieldset class="mb-4">
      <legend class="mb-2 text-xs tracking-wide text-dark-2 uppercase">
        The material may involve
      </legend>
      <div class="flex flex-col gap-2">
        {#each Object.entries(contents) as [key, label] (key)}
          <div class="flex items-start gap-2">
            <Checkbox id="content-{key}" name="contents" value={key} />
            <Label for="content-{key}" class="font-normal text-dark-0">{label}</Label>
          </div>
        {/each}
      </div>
    </fieldset>

    <div class="mb-3 flex items-center gap-2">
      <Checkbox id="csam-confirm" bind:checked={confirmed} />
      <Label for="csam-confirm" class="font-normal text-dark-0">
        I am sure this content is CSAM.
      </Label>
    </div>

    <div class="flex gap-2">
      <Button type="submit" size="sm" variant="destructive" disabled={busy || !confirmed}>
        {busy ? 'Filing…' : 'File CSAM report'}
      </Button>
      <Button type="button" size="sm" variant="outline" onclick={onCancel}>Cancel</Button>
    </div>
  </div>
</form>
