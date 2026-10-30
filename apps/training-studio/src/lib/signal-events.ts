// Signal event-name strings, shared by the server (orchestrator callback registration) and the client
// (subscription). No imports, so it's safe in both a `+server`/lib-server module and a browser component.
// Names match the main app's `SignalMessages`.
export const WORKFLOW_UPDATE_SIGNAL = 'orchestrator:workflow-update';
export const BUZZ_UPDATE_SIGNAL = 'buzz:update';
