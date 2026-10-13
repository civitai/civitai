<script lang="ts">
	import { Popover as PopoverPrimitive } from "bits-ui";
	import { cn } from "@civitai/ui/utils.js";

	// A diamond rather than the primitive's SVG triangle, so it can carry a border that continues the
	// content's own: pass the border colour in `class`. Render it AFTER the content's children so it
	// paints over their edge.
	//
	// The outer span is the slot bits-ui positions and rotates per side; in its local frame the TOP edge
	// is always the content's edge and +y points away from it, so one set of classes serves every side.
	// The diamond is centred 1px inside that edge to cover the content's border, and its right and
	// bottom borders are the two that form the tip after the rotations.
	let {
		class: className,
		...restProps
	}: PopoverPrimitive.ArrowProps & { class?: string } = $props();
</script>

<PopoverPrimitive.Arrow {...restProps}>
	{#snippet child({ props })}
		<span {...props} data-slot="popover-arrow" class="block h-[5px] w-2.5">
			<span
				class={cn(
					"bg-popover absolute top-0 left-1/2 size-2.5 -translate-x-1/2 -translate-y-[calc(50%+1px)] rotate-45 rounded-[2px]",
					className
				)}
			></span>
		</span>
	{/snippet}
</PopoverPrimitive.Arrow>
