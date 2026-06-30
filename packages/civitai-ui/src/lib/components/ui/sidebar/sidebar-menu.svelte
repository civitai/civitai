<script lang="ts">
	import { cn, type WithElementRef } from "@civitai/ui/utils.js";
	import type { HTMLAttributes } from "svelte/elements";

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLUListElement>, HTMLUListElement> = $props();
</script>

<ul
	bind:this={ref}
	data-slot="sidebar-menu"
	data-sidebar="menu"
	class={cn("gap-0 flex w-full min-w-0 flex-col", className)}
	{...restProps}
>
	{@render children?.()}
</ul>
