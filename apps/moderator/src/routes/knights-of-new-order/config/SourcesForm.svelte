<script lang="ts">
  import { untrack } from 'svelte';
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { Switch } from '@civitai/ui/components/ui/switch/index.js';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { FormState } from '$lib/form-state.svelte';
  import type {
    SourcesChange,
    SourcesSettings,
  } from '$lib/server/knights/sources-config.service';
  import { rateToPercent } from './rates';

  let {
    settings,
    lastChange,
  }: { settings: SourcesSettings; lastChange: SourcesChange | null } = $props();

  // Seeded once from the server: the inputs are the moderator's draft until a save reloads the page.
  // An absent key has no rates chosen, so the boxes start empty rather than showing the reader's defaults.
  const seed = untrack(() => settings);
  let enabled = $state(seed.config.enabled);
  let sfwPercent = $state(seed.stored ? rateToPercent(seed.config.sfwRate) : '');
  let nsfwPercent = $state(seed.stored ? rateToPercent(seed.config.nsfwRate) : '');
  let confirming = $state(false);

  const form = new FormState({
    reload: true,
    reset: false,
    onSuccess: (result) => {
      confirming = false;
      toast.success(result?.changed === false ? 'Nothing to change' : 'Saved');
    },
  });

  // Turning the sources on starts filling the queue, so it is the one save that asks first.
  const startsFilling = $derived(enabled && !(settings.stored && settings.config.enabled));

  const describe = (config: { enabled: boolean; sfwRate: number; nsfwRate: number } | null) =>
    config
      ? `${config.enabled ? 'on' : 'off'}, SFW ${rateToPercent(config.sfwRate)}%, NSFW ${rateToPercent(config.nsfwRate)}%`
      : 'not set';
</script>

<section class="rounded-xl border border-dark-4 bg-dark-6 p-5" aria-labelledby="sources-heading">
  <h2 id="sources-heading" class="mb-1 text-base font-semibold text-white">Sources</h2>
  <p class="mb-4 text-sm text-dark-2">
    Scan sampling sends a share of newly scanned images to the Knights. Owner ratings are always
    queued while the sources are on.
  </p>

  <form method="POST" action="?/save" use:enhance={form.enhance} class="flex flex-col gap-4">
    <div class="flex items-center justify-between gap-4">
      <div>
        <Label for="sources-enabled">Sources on</Label>
        <p class="text-xs text-dark-2">
          {settings.stored ? 'Currently ' + (settings.config.enabled ? 'on.' : 'off.') : 'Not set yet, so off.'}
        </p>
      </div>
      <input type="hidden" name="enabled" value={enabled ? 'true' : 'false'} />
      <Switch
        id="sources-enabled"
        bind:checked={() => enabled, (value) => ((enabled = value), (confirming = false))}
      />
    </div>

    <div class="grid grid-cols-2 gap-3">
      <div class="grid gap-1.5">
        <Label for="sources-sfw">SFW rate (%)</Label>
        <Input
          id="sources-sfw"
          name="sfwPercent"
          type="text"
          inputmode="decimal"
          autocomplete="off"
          required
          bind:value={() => sfwPercent, (value) => ((sfwPercent = value), (confirming = false))}
        />
      </div>
      <div class="grid gap-1.5">
        <Label for="sources-nsfw">NSFW rate (%)</Label>
        <Input
          id="sources-nsfw"
          name="nsfwPercent"
          type="text"
          inputmode="decimal"
          autocomplete="off"
          required
          bind:value={() => nsfwPercent, (value) => ((nsfwPercent = value), (confirming = false))}
        />
      </div>
    </div>
    <p class="-mt-2 text-xs text-dark-2">
      Share of scanned images that are enqueued, 0 to 100. Both rates are saved with the switch.
    </p>

    {#if form.error}<ErrorAlert message={form.error} />{/if}

    <div class="flex flex-wrap items-center gap-2">
      {#if startsFilling && confirming}
        <span class="text-sm text-amber-300">Turning this on starts filling the queue.</span>
        <Button type="submit" size="sm" disabled={form.submitting} data-touch-target>
          Yes, turn on and save
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onclick={() => (confirming = false)}
          data-touch-target
        >
          Cancel
        </Button>
      {:else if startsFilling}
        <Button
          type="button"
          size="sm"
          disabled={form.submitting}
          onclick={(event) => {
            // Report the empty or malformed box before asking, so the question is about a valid save.
            const target = event.currentTarget;
            if (target instanceof HTMLButtonElement && target.form?.reportValidity()) confirming = true;
          }}
          data-touch-target
        >
          Save
        </Button>
      {:else}
        <Button type="submit" size="sm" disabled={form.submitting} data-touch-target>Save</Button>
      {/if}
    </div>
  </form>

  <div class="mt-4 border-t border-dark-4 pt-3 text-xs text-dark-2">
    {#if lastChange}
      <p>
        Last changed {lastChange.at.toISOString().slice(0, 16).replace('T', ' ')} UTC by
        {lastChange.moderatorUsername ?? (lastChange.moderatorId ? `#${lastChange.moderatorId}` : 'unknown')}.
      </p>
      <p>From {describe(lastChange.before)} to {describe(lastChange.after)}.</p>
    {:else}
      <p>No change has been recorded yet.</p>
    {/if}
  </div>
</section>
