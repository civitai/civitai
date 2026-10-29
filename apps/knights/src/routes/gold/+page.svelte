<script lang="ts">
  import { enhance } from '$app/forms';
  import StatusBar from '$lib/StatusBar.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();
  const gold = (n: number) => n.toLocaleString('en-US');
  const balance = $derived(data.balance);
  const canConvert = $derived(balance.buzzOnConvert > 0);
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
    <tr>
      <th scope="row">Converted so far</th>
      <td>{gold(balance.converted)}</td>
      <td></td>
    </tr>
  </tbody>
</table>

<p class="muted">
  {gold(balance.goldPerBuzz)} gold is 1 Yellow Buzz, converted in whole Buzz, at least {balance.minBuzz} at a time.
</p>

<form
  method="POST"
  action="?/convert"
  use:enhance={() => {
    converting = true;
    return async ({ update }) => {
      await update();
      converting = false;
    };
  }}
>
  <button type="submit" disabled={!canConvert || converting}>
    {#if canConvert}
      Convert to {balance.buzzOnConvert} Buzz
    {:else}
      Convert
    {/if}
  </button>
</form>
{#if form?.message}
  <p role="status">{form.message}</p>
{/if}

<p><a href="/play">Back</a></p>

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
</style>
