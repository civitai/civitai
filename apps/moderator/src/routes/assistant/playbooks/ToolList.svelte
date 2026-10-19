<script lang="ts">
  // The lookups a playbook can name, as the assistant sees them, so a step can say which one to run.
  // A moderator without one of a lookup's pages does not get it, whatever the playbook says.
  let {
    tools,
  }: {
    tools: { name: string; description: string; inputs: string[]; needs: string[] | null }[];
  } = $props();
</script>

<details class="rounded-xl border border-dark-4 bg-dark-6 p-4 text-sm">
  <summary class="font-semibold text-white">Lookups a playbook can name ({tools.length})</summary>
  <ul class="mt-3 space-y-2">
    {#each tools as tool (tool.name)}
      <li>
        <code class="text-dark-0">{tool.name}</code>
        {#if tool.inputs.length}<span class="text-xs text-dark-2">({tool.inputs.join(', ')})</span>{/if}
        <p class="m-0 text-xs text-dark-2">{tool.description}</p>
        {#if tool.needs}
          <p class="m-0 text-xs text-dark-2">Needs access to {tool.needs.join(' or ')}</p>
        {/if}
      </li>
    {/each}
  </ul>
</details>
