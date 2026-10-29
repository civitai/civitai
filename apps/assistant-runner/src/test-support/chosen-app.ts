import type { ModelMessage } from 'ai';

/**
 * A conversation whose earlier reply chose `app` with `use_open_app`, as the runner hands it to a
 * reply's tools (`ToolContext.history`). The gate refuses every change to an open app the chat
 * neither made nor chose, so a test that writes to the open app starts from this; a test of a new
 * chat passes `NEW_CHAT`.
 */
export function chosenApp(app: string): { earlier: ModelMessage[]; current: ModelMessage[] } {
  const toolCallId = `chose-${app}`;
  return {
    earlier: [
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId, toolName: 'use_open_app', input: { app } }],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId,
            toolName: 'use_open_app',
            output: { type: 'json', value: { app, note: `This chat may now change ${app}.` } },
          },
        ],
      },
    ],
    current: [],
  };
}

/** A new chat: no earlier reply, nothing chosen. */
export const NEW_CHAT: { earlier: ModelMessage[]; current: ModelMessage[] } = {
  earlier: [],
  current: [],
};
