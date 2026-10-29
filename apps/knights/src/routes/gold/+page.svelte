<script lang="ts">
  import { enhance } from '$app/forms';
  import StatusBar from '$lib/StatusBar.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();
  const gold = (n: number) => n.toLocaleString('en-US');
  const balance = $derived(data.balance);
  const canConvert = $derived(data.conversionOpen && balance.buzzOnConvert > 0);
  let converting = $state(false);
</script>

<h1>Gold</h1>

<StatusBar status={data.status} />

<table>
  <tbody>
    <tr>
      <th scope="row">Convertible</th>
      <td>{gold(balance.convertible)}</td>
      <td class="muted">earned and cleared by the Order's checks; yours to convert</td>
    </tr>
    <tr>
      <th scope="row">Awaiting the next check</th>
      <td>{gold(balance.awaitingDetection)}</td>
      <td class="muted">earned, and becomes convertible after the next check</td>
    </tr>
    <tr>
      <th scope="row">Pending</th>
      <td>{gold(balance.pending)}</td>
      <td class="muted">from judgments not yet settled; a wrong one earns nothing</td>
    </tr>
    {#if balance.held}
      <tr class="frozen">
        <th scope="row">Frozen</th>
        <td>{gold(balance.frozen)}</td>
        <td class="muted">kept safe while your account is under review</td>
      </tr>
    {/if}
    {#if balance.onItsWay > 0}
      <tr>
        <th scope="row">On its way</th>
        <td>{gold(balance.onItsWay)}</td>
        <td class="muted">a conversion Buzz has not confirmed yet; it is paid once</td>
      </tr>
    {/if}
    <tr>
      <th scope="row">Converted so far</th>
      <td>{gold(balance.converted)}</td>
      <td class="muted">paid to you as Yellow Buzz</td>
    </tr>
  </tbody>
</table>

<p class="muted">
  {gold(balance.goldPerBuzz)} gold is 1 Yellow Buzz, converted in whole Buzz, at least {balance.minBuzz} at a time.
</p>

{#if !data.conversionOpen}
  <p class="muted">Converting gold to Buzz isn't open yet. Your gold keeps accruing.</p>
{/if}

<form
  method="POST"
  action="?/convert"
  use:enhance={() => {
    converting = true;
    return async ({ update }) => {
      try {
        await update();
      } finally {
        converting = false;
      }
    };
  }}
>
  <button type="submit" disabled={!canConvert || converting}>
    {#if converting}
      Converting…
    {:else if canConvert}
      Convert to {balance.buzzOnConvert} Buzz
    {:else}
      Convert
    {/if}
  </button>
</form>
{#if form?.message}
  {#if form.ok}
    <p role="status" class="ok">{form.message}</p>
  {:else}
    <p role="alert" class="problem">{form.message}</p>
  {/if}
{/if}

<p><a href="/play" data-sveltekit-preload-data="off">Back</a></p>

<style>
  table {
    border-collapse: collapse;
    margin: 1rem 0;
  }
  th,
  td {
    padding: 0.4rem 1rem 0.4rem 0;
    text-align: left;
    border-bottom: 1px solid var(--border);
  }
  .muted {
    color: var(--muted);
  }
  .frozen {
    color: var(--gold);
  }
  .ok {
    color: var(--gold);
  }
  .problem {
    color: #e5766a;
    font-weight: bold;
  }
</style>
