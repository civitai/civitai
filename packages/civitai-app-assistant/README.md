# @civitai/app-assistant

App Assistant's rules, in one place for both places a reply runs: the page
(`src/components/Apps/AppAssistant`, the browser runner) and the server runner
(`apps/assistant-runner`). No React, no DOM, no runtime dependencies.

| Module                  | What                                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------- |
| `gate`                  | The per-reply tool-call cap, `report_ready` verification, `set_checklist`, and the two tools' definitions |
| `instructions`          | The system-prompt rules and the per-reply instructions                                                    |
| `subagents`             | The read-only subagent allowlist and their instructions                                                   |
| `sandbox-client`        | The hosted sandbox service's client, and `openApp`                                                        |
| `app-key` / `app-tools` | App keys and `create_app`                                                                                 |

The page adds what only a page can do (the checklist and ready cards, Build it); the runner adds
the sandbox MCP connection. Neither keeps its own copy of a rule here.

## Add to an app

```jsonc
// package.json
"@civitai/app-assistant": "workspace:*"
```

civitai resolves it through `tsconfig.json` `paths` and the Vitest alias list; a tsup app bundles it
(`noExternal: ['@civitai/app-assistant']`), since it ships TypeScript source.
