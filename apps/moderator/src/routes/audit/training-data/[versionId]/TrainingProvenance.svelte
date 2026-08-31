<script lang="ts">
  import { browser } from '$app/environment';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import { userLookupUrl } from '$lib/entity-url';
  import type { TrainingProvenance } from '$lib/server/training-provenance.service';

  let { versionId }: { versionId: number } = $props();

  // Derived, not fetched into $state: navigating to another version has to re-ask, and an $effect
  // assignment lands the old version's answer on the new page.
  const provenance = $derived(
    browser
      ? fetch(`/api/training-provenance/${versionId}`).then((r): Promise<TrainingProvenance | null> => {
          if (!r.ok) throw new Error(`provenance ${r.status}`);
          return r.json();
        })
      : null
  );
</script>

{#await provenance}
  <p class="text-sm text-dark-2">Checking who paid for this run…</p>
{:then result}
  {#if result}
    {#if !result.reachable}
      <p class="text-sm text-dark-2">
        Could not reach the charge history — this says nothing either way about who paid.
      </p>
    {:else if result.payerUserId === null}
      <p class="text-sm text-dark-2">
        No training charge found for this run. It may predate the retention window.
      </p>
    {:else if result.mismatch}
      <p class="text-sm">
        <Badge class="bg-orange-500/15 text-orange-400">Trained by another account</Badge>
        <span class="ml-1">
          Paid for by
          <a href={userLookupUrl(result.payerUsername ?? result.payerUserId)} class={LINK_CLASS}>
            {result.payerUsername ?? `#${result.payerUserId}`}
          </a>
          on {dateTime(result.chargedAt)}, uploaded by a different account.
        </span>
      </p>
    {:else}
      <p class="text-sm text-dark-2">
        Trained and uploaded by the same account, charged {dateTime(result.chargedAt)}.
      </p>
    {/if}
  {/if}
{:catch}
  <p class="text-sm text-dark-2">Could not check who paid for this run.</p>
{/await}
