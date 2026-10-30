<script lang="ts">
  import { browser } from '$app/environment';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import ListCard from './ListCard.svelte';

  // What the automated abuse detectors have said about THIS account.
  //
  // 🔴 WHY THIS PANEL EXISTS. `/abuse` links every finding's user id into User Lookup, and the
  // destination carried ~20 panels and not one word about abuse detection — a moderator followed a
  // link from the evidence to a page that could not tell them why the account had been flagged.
  // Found by driving the real page as a first-time user, not by reading the code: nothing was
  // broken, so nothing failed.
  //
  // 🔴 THIS COMPONENT DOES NOT DECIDE PERMISSION. The section page mounts it only when
  // `canSeeAbuse` (see +layout.server.ts) — so there is no 403 branch here to get wrong. An earlier
  // revision let the panel mount for everyone and interpret the 403 itself, and a one-line change
  // (`null` -> `{ findings: [] }`) turned a permission boundary into "No detector has ever reported
  // this account" — a reassuring zero shown to someone who simply is not allowed to know. The
  // endpoint re-checks the grant regardless; this is about which layer gets to be wrong.
  export type AbuseFindingRow = {
    id: number;
    runId: number;
    confidence: number;
    reason: string;
    actioned: boolean;
    action: string | null;
    createdAt: string;
  };

  let { userId }: { userId: number } = $props();

  // Same decimal as /abuse, for the same reason: producers do not share a calibration, so a
  // percentage invites a cross-detector ranking that would be meaningless.
  const confidence = (v: number) => v.toFixed(2);

  const findings = $derived(
    browser
      ? fetch(`/api/user-abuse-findings/${userId}`).then(
          (r): Promise<{ findings: AbuseFindingRow[]; truncated: boolean }> => {
            if (!r.ok) throw new Error(String(r.status));
            return r.json();
          }
        )
      : null
  );
</script>

{#if findings}
  {#await findings}
    <p class="text-dark-2">Loading abuse detections…</p>
  {:then { findings: rows, truncated }}
    <!-- 🔴 `capped` is what stops the heading reporting a LIMIT as a TOTAL. The service returns at
         most 50 and says which via `truncated`; without this an account with 300 findings renders
         "Abuse detections (50)" and a moderator concludes they have seen the whole record. On a
         surface whose entire claim is honest reporting, that is the one number that must not lie. -->
    <ListCard
      title="Abuse detections"
      total={rows.length}
      capped={truncated}
      hint="What the automated detectors reported about this account. NOT filtered to actioned findings — 'looked at and deliberately left alone' is a real answer, and the most common one."
      empty="No detector has ever reported this account."
    >
      <!-- The card owns the expand toggle and passes how many rows to draw. Rendering all of them
           regardless leaves a "Show all N" button that changes its own label and nothing else —
           12 of the 13 ListCard call sites in this directory take the argument; this one did not. -->
      {#snippet children(limit: number)}
        <ul class="space-y-3">
          {#each rows.slice(0, limit) as f (f.id)}
            <li class="border-dark-4 border-b pb-3 last:border-0">
              <div class="mb-1 flex flex-wrap items-center gap-2">
                {#if f.actioned}
                  <Badge variant="destructive">Acted: {f.action}</Badge>
                {:else}
                  <!-- The common case, and the one worth reading: detected, scored, left alone. -->
                  <Badge variant="secondary">Not acted on</Badge>
                {/if}
                <span class="text-dark-2 text-sm">{dateTime(f.createdAt)}</span>
                <a class={LINK_CLASS} href="/abuse/{f.runId}">run #{f.runId}</a>
                <!-- 🔴 A confidence of 0.00 is NOT "no signal" — it is a judged verdict of "not
                     abuse", and it renders next to a reason that describes the evidence in detail
                     ("100% farm-IP with 16 …"), which reads as self-contradictory unless labelled.
                     Every finding whose reason begins "Judged and deliberately NOT actioned"
                     carries exactly 0.00 today. Saying so costs one line and stops a moderator
                     either dismissing a real finding or trusting a rejected one. -->
                <span class="text-dark-2 text-sm">
                  confidence {confidence(f.confidence)}{f.confidence === 0
                    ? ' — judged not abuse, not "unscored"'
                    : ''}
                </span>
              </div>
              <p class="text-sm">{f.reason}</p>
            </li>
          {/each}
        </ul>
      {/snippet}
    </ListCard>
  {:catch}
    <!-- An error must not read as "this account is clean" — the two are opposite conclusions and a
         moderator acts differently on each. -->
    <p class="text-red-4">Could not load abuse detections. This is NOT the same as none found.</p>
  {/await}
{/if}
