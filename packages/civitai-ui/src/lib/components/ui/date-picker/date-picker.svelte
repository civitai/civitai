<script lang="ts">
	import CalendarIcon from "@lucide/svelte/icons/calendar";
	import { type DateValue, DateFormatter, getLocalTimeZone } from "@internationalized/date";
	import { cn } from "@civitai/ui/utils.js";
	import { Button } from "@civitai/ui/components/ui/button/index.js";
	import { Calendar } from "@civitai/ui/components/ui/calendar/index.js";
	import * as Popover from "@civitai/ui/components/ui/popover/index.js";

	let {
		value = $bindable(),
		open = $bindable(false),
		placeholder = "Select a date",
		disabled = false,
		locale = "en-US",
		class: className,
	}: {
		value?: DateValue;
		open?: boolean;
		placeholder?: string;
		disabled?: boolean;
		locale?: string;
		class?: string;
	} = $props();

	const df = $derived(new DateFormatter(locale, { dateStyle: "long" }));
</script>

<Popover.Root bind:open>
	<Popover.Trigger {disabled}>
		{#snippet child({ props })}
			<Button
				{...props}
				variant="outline"
				{disabled}
				class={cn(
					"w-[280px] justify-start text-start font-normal",
					!value && "text-muted-foreground",
					className
				)}
			>
				<CalendarIcon class="me-2 size-4" />
				{value ? df.format(value.toDate(getLocalTimeZone())) : placeholder}
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content class="w-auto p-0">
		<Calendar bind:value type="single" captionLayout="dropdown" />
	</Popover.Content>
</Popover.Root>
