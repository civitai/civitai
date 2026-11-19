/**
 * What the sandbox MCP server offers beyond its first tools, and how much of its replies the assistant
 * gets. One place for the page and the server runner.
 */

/**
 * How much of each sandbox tool reply (and error) the assistant gets: its first `head` and last `tail`
 * characters, the cut noted between. Set as the sandbox server's `resultLimit` on the page and on the
 * runner. The chat's default (2,000 and 6,000) cut file reads and test output short enough that the
 * assistant read them again.
 */
export const SANDBOX_RESULT_LIMIT = { head: 6_000, tail: 18_000 } as const;

/** What the chat calls the sandbox server while one of its tools runs, and in its tools' labels. */
export const SANDBOX_SERVER_LABEL = 'your app';

/**
 * The newer sandbox tools a sandbox lists. An older sandbox lists none of them, so every rule and
 * refusal naming one is given only when it is listed.
 */
export interface SandboxFeatures {
  /** `read_files { paths }`: several files in one call. */
  readFiles: boolean;
  /** `edit_file` takes `edits: [{ old_string, new_string, replace_all? }]`, applied in order. */
  batchEdits: boolean;
  /** `run_checks { cwd }`: the tests, then the typecheck, unpiped, with each one's exit code. */
  runChecks: boolean;
}

export const NO_SANDBOX_FEATURES: SandboxFeatures = Object.freeze({
  readFiles: false,
  batchEdits: false,
  runChecks: false,
});

/** The features of a sandbox, from its MCP server's own tool list (names without the `sandbox__` prefix). */
export function sandboxFeaturesOf(
  listed: readonly { name: string; inputSchema?: unknown }[]
): SandboxFeatures {
  const byName = new Map(listed.map((tool) => [tool.name, tool]));
  const editSchema = byName.get('edit_file')?.inputSchema as
    | { properties?: Record<string, unknown> }
    | null
    | undefined;
  return {
    readFiles: byName.has('read_files'),
    batchEdits: editSchema?.properties?.edits !== undefined,
    runChecks: byName.has('run_checks'),
  };
}
