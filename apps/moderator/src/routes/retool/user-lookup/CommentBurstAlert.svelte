<script lang="ts">
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import type { Signals } from './signals';

  // Retool showed this in Quick Info, on the first screen. It spent the migration on the Addresses
  // panel, where the accounts it describes are not what anyone is looking at.
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
        {num(burst.comments)} comments on {num(burst.targets)} different things in the hour of
        {dateTime(burst.hour)}.
      </p>
      <p class="mt-1 text-xs text-dark-2">
        One comment per target in a single hour is what a script does — a conversation revisits a
        thread. Weigh it against how old the account is; established accounts comment in bursts
        legitimately.
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
