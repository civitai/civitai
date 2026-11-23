// The Civitai Elements this app renders, plus the Studio's own elements built on the kit. Each `/define`
// module registers its tag (the bare module only exports the class), and is SSR-safe. Every component
// that uses an element imports this file, so both shells (SvelteKit and the embed) register them.
import '@civitai/components/civitai-action-button/define';
import '@civitai/components/civitai-badge/define';
import '@civitai/components/civitai-button/define';
import '@civitai/components/civitai-card/define';
import '@civitai/components/civitai-text-input/define';
import '@civitai/components/civitai-alert/define';
import '@civitai/components/civitai-avatar/define';
import '@civitai/components/civitai-checkbox/define';
import '@civitai/components/civitai-confirm-dialog/define';
import '@civitai/components/civitai-loader/define';
import '@civitai/components/civitai-menu/define';
import '@civitai/components/civitai-menu-item/define';
import '@civitai/components/civitai-menu-label/define';
import '@civitai/components/civitai-modal/define';
import '@civitai/components/civitai-number-input/define';
import '@civitai/components/civitai-progress/define';
import '@civitai/components/civitai-segmented-control/define';
import '@civitai/components/civitai-select/define';
import '@civitai/components/civitai-textarea/define';
import { defineStudioChipGroup } from './elements/studio-chip-group';
import { defineStudioPopover } from './elements/studio-popover';

defineStudioChipGroup();
defineStudioPopover();
