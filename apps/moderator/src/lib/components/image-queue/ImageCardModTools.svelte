<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { optimisticEnhancer } from '$lib/form-action';
  import { imageFlagValue, type ImageFlag } from '$lib/image-flags';
  import { browsingLevels, getBrowsingLevelLabel } from '@civitai/shared';

  let {
    imageIds,
    nsfwLevel,
    minor,
    poi,
    rating = true,
  }: {
    /** Comma-separated — the same value the bulk forms post, so one component serves card and bar. */
    imageIds: string;
    /** `null` = a selection whose members may differ. No chip reads as current and each flag becomes an
     *  explicit set/clear pair, because a toggle over a batch has to lie about one half of it. */
    nsfwLevel: number | null;
    minor: boolean | null;
    poi: boolean | null;
    /** Off on the appeal queue: those images are `Blocked`, and setting a level writes
     *  `nsfwLevelLocked` over a state the appeal decision is about to replace. */
    rating?: boolean;
  } = $props();

  // Neither write reloads the page (a queue of a hundred cards would refetch on every rating), so what
  // the moderator just set is held here and dropped only if the server refuses it.
  let levelSet = $state<number | null>(null);
  let minorSet = $state<boolean | null>(null);
  let poiSet = $state<boolean | null>(null);
  let busy = $state(false);

  const level = $derived(levelSet ?? nsfwLevel);
  const flagState = $derived<Record<ImageFlag, boolean | null>>({
    minor: minorSet ?? minor,
    poi: poiSet ?? poi,
  });

  /** The in-flight lock has to clear on refusal too, or a rejected write leaves the card dead. */
  const untilSettled =
    (inner: SubmitFunction): SubmitFunction =>
    async (input) => {
      busy = true;
      const callback = await inner(input);
      return async (opts) => {
        await callback?.(opts);
        busy = false;
      };
    };

  const rate = untilSettled(
    optimisticEnhancer(({ formData }) => {
      const previous = levelSet;
      levelSet = Number(formData.get('nsfwLevel'));
      return () => (levelSet = previous);
    })
  );

  const flag = untilSettled(
    optimisticEnhancer(({ formData }) => {
      const [name, value] = String(formData.get('flagValue') ?? '').split(':');
      const previous = name === 'minor' ? minorSet : poiSet;
      if (name === 'minor') minorSet = value === 'true';
      else poiSet = value === 'true';
      return () => {
        if (name === 'minor') minorSet = previous;
        else poiSet = previous;
      };
    })
  );

  const FLAGS: { name: ImageFlag; label: string; active: string }[] = [
    { name: 'minor', label: 'Minor', active: 'border-rose-600 bg-rose-600/20 text-rose-300' },
    { name: 'poi', label: 'POI', active: 'border-orange-600 bg-orange-600/20 text-orange-300' },
  ];

  const chip = 'rounded border px-1.5 py-0.5 text-xs font-semibold transition disabled:opacity-50';
  const off = 'border-dark-4 text-dark-2 hover:border-dark-2';
</script>

<div class="flex flex-wrap items-center gap-1">
  {#if rating}
    <form method="POST" action="?/setRating" use:enhance={rate} class="flex flex-wrap gap-1">
      <input type="hidden" name="imageIds" value={imageIds} />
      {#each browsingLevels as bit (bit)}
        <button
          type="submit"
          name="nsfwLevel"
          value={bit}
          disabled={busy || level === bit}
          title="Set rating to {getBrowsingLevelLabel(bit)}"
          class="{chip} {level === bit ? 'border-primary bg-primary text-primary-foreground' : off}"
        >
          {getBrowsingLevelLabel(bit)}
        </button>
      {/each}
    </form>
  {/if}

  <form method="POST" action="?/setFlag" use:enhance={flag} class="flex flex-wrap gap-1">
    <input type="hidden" name="imageIds" value={imageIds} />
    {#each FLAGS as f (f.name)}
      {@const on = flagState[f.name]}
      {#if on === null}
        {#each [true, false] as value (value)}
          <button
            type="submit"
            name="flagValue"
            value={imageFlagValue(f.name, value)}
            disabled={busy}
            class="{chip} {off}"
          >
            {value ? 'Set' : 'Clear'}
            {f.label}
          </button>
        {/each}
      {:else}
        <button
          type="submit"
          name="flagValue"
          value={imageFlagValue(f.name, !on)}
          disabled={busy}
          title={on ? `Clear ${f.label}` : `Set ${f.label}`}
          class="{chip} {on ? f.active : off}"
        >
          {f.label}{on ? ' ✓' : ''}
        </button>
      {/if}
    {/each}
  </form>
</div>
