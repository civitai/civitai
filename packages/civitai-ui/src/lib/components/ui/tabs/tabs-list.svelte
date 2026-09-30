<script lang="ts">
	import { Tabs as TabsPrimitive } from "bits-ui";
	import { cn } from "@civitai/ui/utils.js";

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: TabsPrimitive.ListProps = $props();
</script>

<!-- flex-wrap, w-fit and h-auto are load-bearing together; pinned by tabs-list.classes.test.ts.
     Without wrapping, the nowrap triggers make this row's min-content equal its max-content, so
     w-fit (fit-content) cannot clamp and the list spills out of every overflow:visible ancestor
     as page-level horizontal scroll. h-auto is required BY the wrap: a fixed height does not
     grow with the rows, so wrapped rows overflow the box and overlap what is below it (they are
     not clipped -- overflow here is visible, so overflow-hidden is NOT the equivalent fix).
     The clamp holds only down to the widest SINGLE trigger, which stays nowrap. -->
<TabsPrimitive.List
	bind:ref
	data-slot="tabs-list"
	class={cn(
		"bg-muted text-muted-foreground inline-flex h-auto w-fit flex-wrap items-center justify-center rounded-lg p-[3px]",
		className
	)}
	{...restProps}
/>
