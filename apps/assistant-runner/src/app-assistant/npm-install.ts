/**
 * The runner's own `npm install` in an app's project, shared by the SDK upgrade (`sdk-pin.ts`) and
 * the page's Start app (`RunnerPreview.startDevServer`): one command, one bound.
 */

/**
 * The sandbox's own bound on the install (its `timeout_ms`: the sandbox kills the install's whole
 * process group past it, and answers). An App Block has a handful of dependencies and keeps its
 * `node_modules` across a pause, so bumping one of them is an install of seconds to a few tens of
 * seconds; 90 s leaves room for a cold npm cache without letting a wedged registry hold the reply.
 */
export const NPM_INSTALL_TIMEOUT_MS = 90_000;
/** How long one MCP call waits past the sandbox's own bound on its command, for its answer. */
export const CALL_SLACK_MS = 10_000;
/** How long the runner waits for the install's answer: the sandbox's bound plus `CALL_SLACK_MS`. */
export const NPM_INSTALL_CALL_TIMEOUT_MS = NPM_INSTALL_TIMEOUT_MS + CALL_SLACK_MS;

/** The sandbox as the install needs it: the runner's own call of one of its tools. */
export interface NpmInstallSandbox {
  call(
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    options?: { timeoutMs?: number }
  ): Promise<{ text: string; isError: boolean }>;
}

/** `cd <dir> && npm install`, for a `dir` already checked to be a plain project name. */
export function npmInstallCommand(dir: string): string {
  return `cd ${dir} && npm install --no-audit --no-fund`;
}

/**
 * Runs the install in `dir` with `sandbox__run_command`, bounded as above: its answer, or a throw
 * when it gave none in time (it may have changed files all the same).
 */
export function runNpmInstall(
  sandbox: NpmInstallSandbox,
  dir: string,
  signal?: AbortSignal
): Promise<{ text: string; isError: boolean }> {
  return sandbox.call(
    'run_command',
    { command: npmInstallCommand(dir), timeout_ms: NPM_INSTALL_TIMEOUT_MS },
    signal,
    { timeoutMs: NPM_INSTALL_CALL_TIMEOUT_MS }
  );
}

/**
 * A `sandbox__run_command` command that prints `installing` when an npm install (`npm install`,
 * `npm i`, `npm ci`, `npm add`, however npm was launched) runs anywhere in the sandbox, else
 * `idle`, reading every process's `/proc/<pid>/cmdline` with node (the image may have no `pgrep`).
 * `procRoot` is for tests only.
 *
 * It cannot see itself: the script never spells an install out, so neither its own command line
 * nor that of the shell the sandbox runs it in matches (`npm-install.test.ts` runs it against a
 * process list holding both). Entries of `procRoot` that are not a number (`self`, `sys`) are
 * passed over, whatever their `cmdline` says (pinned by the same tests).
 */
export function npmInstallRunningProbe(procRoot = '/proc'): string {
  const script =
    'const fs=require("fs");const root=process.argv[1];' +
    'const re=/(^|[\\s\\/])npm(-cli\\.js)?\\s+(install|i|ci|add)(\\s|$)/;let hit=false;' +
    'for(const p of fs.readdirSync(root)){if(!/^[0-9]+$/.test(p)||Number(p)===process.pid)continue;' +
    'let c;try{c=fs.readFileSync(root+"/"+p+"/cmdline","latin1")}catch{continue}' +
    'if(re.test(c.split("\\0").join(" ")))hit=true}' +
    'process.stdout.write(hit?"installing":"idle")';
  return `node -e '${script}' ${procRoot}`;
}
