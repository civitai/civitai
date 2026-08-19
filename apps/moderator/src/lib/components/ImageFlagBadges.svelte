<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';

  // One flag → one colour, everywhere. Four pages rendered this same set with four different mappings:
  // `minor` was destructive on Image Lookup and secondary in Bulk Image Manager, `needsReview` was
  // destructive on one and secondary on two, and Post Lookup had invented a fifth palette of raw
  // Tailwind colours. The mapping is operator-facing — a moderator who learns "red means a verdict has
  // been reached" on one screen should not have to relearn it on the next.
  //
  // destructive = a verdict has been recorded against this image.
  // secondary   = a property or a pending question, which is NOT the same claim.
  //
  // Callers own everything else in the row (dates, prompts, per-page badges); this renders the flags
  // only, unwrapped, so it drops into an existing flex row.
  let {
    tosViolation = false,
    ingestion,
    blockedFor,
    needsReview,
    minor = false,
    acceptableMinor = false,
    poi = false,
  }: {
    tosViolation?: boolean;
    /** Passed where the caller has it: `'Blocked'` is what actually hides the image, and `blockedFor`
     *  alone can be set on a row that is still live. */
    ingestion?: string | null;
    blockedFor?: string | null;
    needsReview?: string | null;
    minor?: boolean;
    acceptableMinor?: boolean;
    poi?: boolean;
  } = $props();

  const blocked = $derived(ingestion === 'Blocked' || (ingestion === undefined && !!blockedFor));
</script>

{#if blocked}
  <Badge variant="destructive">blocked{blockedFor ? `: ${blockedFor}` : ''}</Badge>
{/if}
{#if tosViolation}<Badge variant="destructive">ToS</Badge>{/if}
{#if minor}<Badge variant="destructive">minor</Badge>{/if}
{#if needsReview}<Badge variant="secondary">{needsReview}</Badge>{/if}
{#if acceptableMinor}<Badge variant="secondary">acceptable minor</Badge>{/if}
{#if poi}<Badge variant="secondary">POI</Badge>{/if}
