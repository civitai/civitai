<script lang="ts" module>
	export type ComboboxOption = { value: string; label: string; disabled?: boolean };
</script>

<script lang="ts">
	import CheckIcon from "@lucide/svelte/icons/check";
	import ChevronsUpDownIcon from "@lucide/svelte/icons/chevrons-up-down";
	import { tick } from "svelte";
	import * as Command from "@civitai/ui/components/ui/command/index.js";
	import * as Popover from "@civitai/ui/components/ui/popover/index.js";
	import { Button } from "@civitai/ui/components/ui/button/index.js";
	import { cn } from "@civitai/ui/utils.js";

	let {
		options = [],
		value = $bindable(""),
		open = $bindable(false),
		placeholder = "Select an option...",
		searchPlaceholder = "Search...",
		emptyText = "No results found.",
		disabled = false,
		class: className,
		contentClass,
	}: {
		options: ComboboxOption[];
		value?: string;
		open?: boolean;
		placeholder?: string;
		searchPlaceholder?: string;
		emptyText?: string;
		disabled?: boolean;
		class?: string;
		contentClass?: string;
	} = $props();

	let triggerRef = $state<HTMLButtonElement>(null!);
	const selectedLabel = $derived(options.find((o) => o.value === value)?.label);

	function closeAndFocusTrigger() {
		open = false;
		tick().then(() => triggerRef.focus());
	}
</script>

<Popover.Root bind:open>
	<Popover.Trigger bind:ref={triggerRef} {disabled}>
		{#snippet child({ props })}
			<Button
				{...props}
				variant="outline"
				role="combobox"
				aria-expanded={open}
				{disabled}
				class={cn("w-[200px] justify-between", className)}
			>
				<span class="truncate">{selectedLabel ?? placeholder}</span>
				<ChevronsUpDownIcon class="opacity-50" />
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content class={cn("w-[200px] p-0", contentClass)}>
		<Command.Root>
			<Command.Input placeholder={searchPlaceholder} />
			<Command.List>
				<Command.Empty>{emptyText}</Command.Empty>
				<Command.Group value="options">
					{#each options as option (option.value)}
						<Command.Item
							value={option.value}
							disabled={option.disabled}
							onSelect={() => {
								value = option.value;
								closeAndFocusTrigger();
							}}
						>
							<CheckIcon class={cn(value !== option.value && "text-transparent")} />
							{option.label}
						</Command.Item>
					{/each}
				</Command.Group>
			</Command.List>
		</Command.Root>
	</Popover.Content>
</Popover.Root>
