<script lang="ts">
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import type { Signals } from './signals';

  let { signals, civitaiUrl, username }: {
    signals: Promise<Signals> | null;
    civitaiUrl: string;
    username: string | null;
  } = $props();
</script>

{#await signals then result}
  {#if result?.commentBurst?.matchesSignature}
    {@const burst = result.commentBurst}
    <div class="mb-4 rounded-xl border border-red-500/40 bg-red-500/10 p-4" role="status">
      <p class="text-sm font-semibold text-red-200">Comment spam signature</p>
      <p class="mt-1 text-sm text-dark-0">
        {num(burst.comments)} comments in the hour of {dateTime(burst.hour)}, when the account was
        {burst.ageAtBurstHours < 1 ? 'under an hour' : `${Math.round(burst.ageAtBurstHours)} hours`} old.
      </p>
      <p class="mt-1 text-xs text-dark-2">
        That volume from an account this young was banned 98.9% of the time over the last 90 days; the
        same volume from an older account, 1.2%.
        {#if username}
          <a
            href="{civitaiUrl}/user/{username}"
            target="_blank"
            rel="noreferrer"
            class="ml-1 {LINK_CLASS}">Open their profile</a
          >
        {/if}
      </p>
    </div>
  {/if}
{/await}
