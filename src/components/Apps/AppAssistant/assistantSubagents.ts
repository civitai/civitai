import type { ChatSubagents } from '@civitai/components-chat/civitai-chat';
import { APP_ASSISTANT_SUBAGENTS as SHARED_SUBAGENTS } from '@civitai/app-assistant';

// The allowlist and the subagents' instructions live in `@civitai/app-assistant`, so the server runner
// gives its subagents the same ones.
export {
  APP_ASSISTANT_SUBAGENT_INSTRUCTIONS,
  APP_ASSISTANT_SUBAGENT_TOOLS,
} from '@civitai/app-assistant';

/** What `<civitai-chat>` gets as `subagents` when they are on; the caps and the model stay the chat's defaults. */
export const APP_ASSISTANT_SUBAGENTS: ChatSubagents = SHARED_SUBAGENTS;
