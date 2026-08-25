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
          (r): Promise<{ findings: AbuseFindingRow[] } | null> => {
            // 🔴 403 IS NOT AN ERROR HERE, it is "this panel is not yours". User Lookup is granted
            // more widely than /abuse, so staff and payroll moderators legitimately land on this
            // section without rights to abuse findings. Showing them a red failure banner would
            // report a permission boundary as a broken page — and invite a support ticket about an
            // outage that is not one. Render nothing instead.
            if (r.status === 403) return Promise.resolve(null);
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
  {:then payload}
    {#if payload}
      {@const rows = payload.findings}
    <ListCard
      title="Abuse detections"
      total={rows.length}
      hint="What the automated detectors reported about this account. NOT filtered to actioned findings — 'looked at and deliberately left alone' is a real answer, and the most common one."
      empty="No detector has ever reported this account."
    >
      <ul class="space-y-3">
        {#each rows as f (f.id)}
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
                   Every finding whose reason begins "Judged and deliberately NOT actioned" carries
                   exactly 0.00 today. Saying so here costs one line and stops a moderator either
                   dismissing a real finding or trusting a rejected one. -->
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
    </ListCard>
    {/if}
  {:catch}
    <!-- An error must not read as "this account is clean" — the two are opposite conclusions and a
         moderator acts differently on each. -->
    <p class="text-red-4">Could not load abuse detections. This is NOT the same as none found.</p>
  {/await}
{/if}
