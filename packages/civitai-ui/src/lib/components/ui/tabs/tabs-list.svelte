<script lang="ts">
	import { Tabs as TabsPrimitive } from "bits-ui";
	import { cn } from "@civitai/ui/utils.js";

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: TabsPrimitive.ListProps = $props();
</script>

<!-- flex-wrap is load-bearing, and h-auto is required by it. Without wrapping, the nowrap
     triggers make this row's min-content equal its max-content, so w-fit (fit-content) cannot
     clamp to the container and the list spills out of every overflow:visible ancestor as
     page-level horizontal scroll. h-9 would then clip any wrapped row to zero height. -->
<TabsPrimitive.List
	bind:ref
	data-slot="tabs-list"
	class={cn(
		"bg-muted text-muted-foreground inline-flex h-auto w-fit flex-wrap items-center justify-center rounded-lg p-[3px]",
		className
	)}
	{...restProps}
/>
