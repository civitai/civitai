// The Civitai Elements this app renders, plus the Studio's own elements built on the kit. Each `/define`
// module registers its tag (the bare module only exports the class), and is SSR-safe. Every component
// that uses an element imports this file, so both shells (SvelteKit and the embed) register them.
import '@civitai/components/civitai-badge/define';
import '@civitai/components/civitai-button/define';
import '@civitai/components/civitai-text-input/define';
import { defineStudioChipGroup } from './elements/studio-chip-group';

defineStudioChipGroup();
