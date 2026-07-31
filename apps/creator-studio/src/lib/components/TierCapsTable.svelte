<script lang="ts">
  import { tierCapRows } from '$lib/monetization/paid-access';
  import { feeToRatio } from '$lib/monetization/fee';

  // `capTier` is what cap math resolves to, not the display tier — a lapsed membership keeps its label
  // but is charged at free, and the highlighted row has to match what the inputs will actually allow.
  let { capTier = 'free', class: className = '' }: { capTier?: string; class?: string } = $props();

  const rows = tierCapRows();
  const fmt = (n: number | null) => (n === null ? '∞' : n.toLocaleString());

  // Caps are stored per generation but entered as a whole-number ratio, so a fractional cap (0.1, 0.5)
  // has no meaning in the editor. feeToRatio maps each one back onto the denominator the creator will
  // actually type against — every current cap lands on 1 or 10.
  const feeRatio = (perGen: number, noun: string) => {
    const { buzz, images } = feeToRatio(perGen);
    return `${buzz.toLocaleString()} ⚡ / ${images} ${noun}${images === 1 ? '' : 's'}`;
  };

  const rowCls = (tier: string) => (tier === capTier ? 'bg-dark-5/60 text-white' : 'text-dark-1');
  const headCls = 'py-1.5 pr-3 text-right font-medium';
  const cellCls = 'whitespace-nowrap py-1.5 pr-3 text-right tabular-nums';
</script>

<div class={className}>
  <div class="mb-4 overflow-x-auto">
    <p class="mb-1 text-xs font-medium text-white">
      Licensing fees <span class="font-normal text-dark-2">— earned per generation</span>
    </p>
    <table class="w-full min-w-152 border-collapse text-left text-xs">
      <thead>
        <tr class="text-dark-2">
          <th class="py-1.5 pr-3 font-medium"></th>
          <th class="border-l border-dark-5 py-1.5 pl-2 pr-3 text-center font-medium" colspan="2"
            >Checkpoint</th
          >
          <th class="border-l border-dark-5 py-1.5 pl-2 pr-3 text-center font-medium" colspan="2"
            >Every other model type</th
          >
        </tr>
        <tr class="text-dark-2">
          <th class="py-1.5 pr-3 font-medium">Tier</th>
          <th class="border-l border-dark-5 py-1.5 pl-2 pr-3 text-right font-medium">Image</th>
          <th class={headCls}>Video</th>
          <th class="border-l border-dark-5 py-1.5 pl-2 pr-3 text-right font-medium">Image</th>
          <th class="py-1.5 pr-2 text-right font-medium">Video</th>
        </tr>
      </thead>
      <tbody>
        {#each rows as row (row.tier)}
          <tr class={rowCls(row.tier)}>
            <td class="whitespace-nowrap rounded-l py-1.5 pl-2 pr-3 font-medium">
              {row.label}
              {#if row.tier === capTier}<span class="ml-1 text-blue-4">· you</span>{/if}
            </td>
            <td class="{cellCls} border-l border-dark-5 pl-2"
              >{feeRatio(row.image.feeCheckpoint, 'image')}</td
            >
            <td class={cellCls}>{feeRatio(row.video.feeCheckpoint, 'video')}</td>
            <td class="{cellCls} border-l border-dark-5 pl-2"
              >{feeRatio(row.image.feeOther, 'image')}</td
            >
            <td class="{cellCls} rounded-r pr-2">{feeRatio(row.video.feeOther, 'video')}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>

  <div class="mb-3 overflow-x-auto">
    <p class="mb-1 text-xs font-medium text-white">
      Paid access <span class="font-normal text-dark-2">— one-time price to unlock a version</span>
    </p>
    <table class="w-full min-w-104 border-collapse text-left text-xs">
      <thead>
        <tr class="text-dark-2">
          <th class="py-1.5 pr-3 font-medium">Tier</th>
          <th class={headCls}>Image models</th>
          <th class={headCls}>Video models</th>
          <th class="py-1.5 pr-2 text-right font-medium">Permanent gates</th>
        </tr>
      </thead>
      <tbody>
        {#each rows as row (row.tier)}
          <tr class={rowCls(row.tier)}>
            <td class="whitespace-nowrap rounded-l py-1.5 pl-2 pr-3 font-medium">
              {row.label}
              {#if row.tier === capTier}<span class="ml-1 text-blue-4">· you</span>{/if}
            </td>
            <td class={cellCls}>{fmt(row.image.paidAccessPrice)} ⚡</td>
            <td class={cellCls}>{fmt(row.video.paidAccessPrice)} ⚡</td>
            <td class="{cellCls} rounded-r pr-2">{fmt(row.permanentGates)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>

  <p class="text-xs text-dark-2">
    A version's base model decides whether it prices as image or video — video allows more because
    it costs more to generate.
  </p>
  <p class="mt-1 text-xs text-dark-2">
    Caps limit how much you can charge, not whether you can charge. An existing price above your cap
    keeps earning at the cap and is restored in full if you upgrade — it's never rewritten.
  </p>
</div>
