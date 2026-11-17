<script lang="ts">
  import { agentReportFilterLabels, agentReportFilters, type AgentReportFilter } from '$lib/agent-reports';

  /** All / agents only / hide agents, for a report queue. The caller writes the URL (`setAgentReportParam`)
   *  and resets its own paging. */
  let { value, onselect }: { value: AgentReportFilter; onselect: (filter: AgentReportFilter) => void } =
    $props();
</script>

<div class="flex items-center gap-1" role="group" aria-label="Agent reports">
  {#each agentReportFilters as filter (filter)}
    <button
      type="button"
      aria-pressed={value === filter}
      class="rounded border px-2 py-1 text-xs font-semibold transition {value === filter
        ? 'border-primary bg-primary text-primary-foreground'
        : 'border-dark-4 text-dark-2 hover:border-dark-2'}"
      onclick={() => value !== filter && onselect(filter)}
    >
      {agentReportFilterLabels[filter]}
    </button>
  {/each}
</div>
