import {
  BLOCK_SLUG,
  CIVITAI_SDK,
  CIVITAI_SDK_FLOOR,
  checkSdkPin,
  installedSdkBelowFloor,
  type Sandbox,
} from '@civitai/app-assistant';
import type { ChatToolResult } from '@civitai/components-chat/runner-protocol';

import type { Logger } from '../core/interfaces';
import { exitCodeOf, manifestOf, outputOf, projectDirOf } from './preview';

/** How long a reply's start waits for the pin check's reads: past it, the reply goes without. */
export const SDK_PIN_READ_TIMEOUT_MS = 5_000;
/**
 * The sandbox's own bound on the upgrade's `npm install` (its `timeout_ms`: the sandbox kills the
 * install's whole process group past it, and answers). An App Block has a handful of dependencies
 * and keeps its `node_modules` across a pause, so bumping one of them is an install of seconds to a
 * few tens of seconds; 90 s leaves room for a cold npm cache without letting a wedged registry hold
 * the reply.
 */
export const SDK_INSTALL_TIMEOUT_MS = 90_000;
/**
 * The upgrade's budget, judged between its steps: a step that ends past it is followed by the
 * rollback, never by the next step. No step is cut off mid-call: cancelling an MCP call does not stop
 * the command in the sandbox (sandbox-mcp answers each request on its own server, so a cancel never
 * reaches the install; only closing the connection kills it), so an install "abandoned" by the
 * runner would keep running beside the rollback's. Every step has its own bound instead: the
 * install's `SDK_INSTALL_TIMEOUT_MS` in the sandbox, the dev server's wait to listen
 * (`DEV_SERVER_WAIT_MS`), and each call's MCP timeout. 150 s is the install's 90 s, a restart's
 * ~30 s, and the reads and writes around them.
 */
export const SDK_UPGRADE_TIMEOUT_MS = 150_000;
/** How long one MCP call waits past the sandbox's own bound on its command, for its answer. */
const CALL_SLACK_MS = 10_000;
/** The most of `package-lock.json` that is kept to put back: an app's lockfile larger than this is not upgraded. */
const LOCKFILE_MAX_BYTES = 1024 * 1024;
/** How many tries an app gets per conversation for one (declared, installed) pair: once, and once more. */
const ATTEMPTS = 2;
/** The most conversations whose tries are remembered; the oldest is forgotten past it. */
const REMEMBERED = 10_000;
/** The range written: only ever the floor constant's own, never a range read from anywhere. */
const TARGET_RANGE = `^${CIVITAI_SDK_FLOOR}`;
const FLOOR_MINOR = CIVITAI_SDK_FLOOR.split('.').slice(0, 2).join('.');
/** The one line a reply starts with after the runner upgraded its app. */
export const SDK_UPGRADED_LINE = `Updated this app's Civitai SDK to ${FLOOR_MINOR} so the preview stays awake while you use it.`;

export interface SdkPinSandbox {
  readonly active: Pick<Sandbox, 'name' | 'app' | 'state'> | null;
  call(
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    options?: { timeoutMs?: number }
  ): Promise<{ text: string; isError: boolean }>;
}

class PinReadTimeout extends Error {
  override name = 'PinReadTimeout';
}

/** Where an upgrade stopped, and why. */
class UpgradeFailed extends Error {
  override name = 'UpgradeFailed';
  constructor(
    readonly stage: 'backup' | 'write' | 'install' | 'verify' | 'restart',
    readonly reason: string
  ) {
    super(`${stage}: ${reason}`);
  }
}

/** What the pin check found: the file as read, and what is below the floor in it. */
interface StalePin {
  /** `package.json`'s exact text. */
  text: string;
  pkg: Record<string, unknown>;
  declared: string;
  /** The declared range is below the floor (else only the installed SDK is). */
  declaredStale: boolean;
  /** The installed version when it is below the floor too (part of the pair the tries count by). */
  installedStale: string | null;
  /** The installed version, whatever it is (`null`: none installed, or unreadable). */
  installedBefore: string | null;
}

/** The dev server before the upgrade: in this project, in another (or unknown) one, or not running. */
type DevServerBefore = 'here' | 'elsewhere' | 'none';

export interface SdkUpgradeInput {
  sandbox: SdkPinSandbox;
  /** Whether the sandbox listed a tool (by its own name, `run_command`): its MCP server answers it. */
  hasTool(name: string): boolean;
  /** Starts the app's dev server with the shared command and waits for it to listen (`RunnerPreview.startDevServer`). */
  startDevServer(): Promise<void>;
  /** Tells the reply's gates (the runner's and the page's) of the install, as of any command run. */
  report?(result: ChatToolResult): void;
  conversationId: string;
  runId: string;
  log: Logger;
  /** The run's Stop: a run already stopped is not upgraded; one stopped meanwhile finishes or rolls back. */
  signal?: AbortSignal;
}

/**
 * The runner's own upgrade, as a reply opens, of an app whose `@civitai/sdk` is below
 * `CIVITAI_SDK_FLOOR`: the range `<app key>/package.json` declares, or the version installed in its
 * `node_modules`, read with the sandbox's own `read_file`. Done by the runner, never asked of the
 * assistant (told in prose, it was seen answering the user and upgrading nothing), and before the
 * assistant's first step, so no call of its own (an edit of `package.json`, an `npm install`) runs
 * meanwhile:
 *
 * 1. `package-lock.json` is kept (its text, or that there is none), to put back on failure;
 * 2. only the `@civitai/sdk` range is set to `^CIVITAI_SDK_FLOOR`, in the section it is in, the file
 *    otherwise byte for byte as it was (a layout a rewrite would not keep is left alone);
 * 3. `cd <app key> && npm install`, which brings the lockfile and `node_modules` to the new range and
 *    keeps every other locked version;
 * 4. the installed version is read again: it must be at the floor now;
 * 5. a running dev server is restarted: in this project with the shared command, in another with its
 *    own previous command (`dev_server_restart`).
 *
 * Any failure, or a step ending past the budget (`SDK_UPGRADE_TIMEOUT_MS`), puts `package.json` and
 * the lockfile back as they were, installs again over them when an install ran, checks the version
 * installed is the one before, and starts the dev server again if the upgrade had stopped it. It is
 * logged, and the reply goes on. Each app gets `ATTEMPTS` tries per conversation for one (declared,
 * installed) pair, so a broken app is not installed into every turn. Kept in this process's memory:
 * a restarted runner may try once more.
 *
 * One upgrade per sandbox at a time in this process: a reply opening while another reply's upgrade
 * (or rollback) still runs in the same app waits for it, then checks the pin afresh. A run stopped
 * meanwhile does not cut it short: it finishes or rolls back, since a half-done one is the worst
 * outcome. Not covered: another runner process working in the same sandbox.
 *
 * Fails open, changing nothing: an app that is not running or listed no tools, an unusual app key,
 * a sandbox without `run_command` or `write_file`, an unreadable or unparseable `package.json`, a
 * range it cannot read, a lockfile it cannot keep whole, or reads past `SDK_PIN_READ_TIMEOUT_MS`.
 * Nothing here throws.
 */
export class SdkUpgrades {
  /** `conversation \n app` → the (declared, installed) pair last tried, and how often. */
  readonly #tried = new Map<string, { pair: string; attempts: number }>();
  /** Sandbox name → the upgrade working in it now. */
  readonly #working = new Map<string, Promise<unknown>>();
  readonly #readTimeoutMs: number;
  readonly #upgradeTimeoutMs: number;

  constructor(options: { readTimeoutMs?: number; upgradeTimeoutMs?: number } = {}) {
    this.#readTimeoutMs = options.readTimeoutMs ?? SDK_PIN_READ_TIMEOUT_MS;
    this.#upgradeTimeoutMs = options.upgradeTimeoutMs ?? SDK_UPGRADE_TIMEOUT_MS;
  }

  /**
   * Upgrades the open app when its SDK is stale; resolves with what the reply's instructions get
   * after an upgrade (the line to tell the user), else `null`.
   */
  async upgrade(input: SdkUpgradeInput): Promise<string | null> {
    const app = input.sandbox.active;
    if (!app || app.state !== 'running' || !input.hasTool('read_file')) return null;
    // Another reply's upgrade in this sandbox finishes first (it never throws).
    for (let earlier = this.#working.get(app.name); earlier; earlier = this.#working.get(app.name))
      await earlier;
    const run = this.#upgrade(input, app.app);
    this.#working.set(app.name, run);
    try {
      return await run;
    } finally {
      if (this.#working.get(app.name) === run) this.#working.delete(app.name);
    }
  }

  async #upgrade(input: SdkUpgradeInput, dir: string): Promise<string | null> {
    const { conversationId, runId, log } = input;
    if (input.signal?.aborted) return null;
    // The project directory goes into a shell command: an app key only.
    if (!BLOCK_SLUG.test(dir)) {
      log.info({ runId, reason: 'app_key' }, `${CIVITAI_SDK} pin not checked: unusual app key`);
      return null;
    }
    const found = await this.#check(input, dir);
    if (!found) return null;

    const key = `${conversationId}\n${dir}`;
    const pair = `${found.declared}\n${found.installedStale ?? ''}`;
    const tried = this.#tried.get(key);
    const attempts = tried?.pair === pair ? tried.attempts : 0;
    if (attempts >= ATTEMPTS) return null;
    const notUpgraded = (reason: string) => {
      // Nothing can change while the pair does not: not looked at again for it.
      this.#remember(key, pair, ATTEMPTS);
      log.info(
        { runId, reason, declared: found.declared.slice(0, 100) },
        `${CIVITAI_SDK} not upgraded: ${reason}`
      );
      return null;
    };
    if (!input.hasTool('run_command') || !input.hasTool('write_file'))
      return notUpgraded('no_exec_tool');
    const rewritten = found.declaredStale ? rewriteSdkRange(found.text, found.pkg) : found.text;
    if (rewritten === null) return notUpgraded('layout');
    if (input.signal?.aborted) return null;
    this.#remember(key, pair, attempts + 1);
    return this.#run(input, dir, found, rewritten);
  }

  /** The pin check's reads, bounded as a whole (a call first waits for the MCP connection). */
  async #check(input: SdkUpgradeInput, dir: string): Promise<StalePin | null> {
    const { runId, log } = input;
    const stop = new AbortController();
    const abort = () => stop.abort();
    input.signal?.addEventListener('abort', abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        stop.abort();
        reject(new PinReadTimeout());
      }, this.#readTimeoutMs);
    });
    try {
      return await Promise.race([
        this.#read(input.sandbox, dir, runId, log, stop.signal),
        timedOut,
      ]);
    } catch (error) {
      log.info(
        {
          runId,
          reason: error instanceof PinReadTimeout ? 'timeout' : 'read_failed',
          err: (error as Error)?.name,
        },
        `${CIVITAI_SDK} pin not checked: reading package.json failed`
      );
      return null;
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', abort);
      stop.abort();
    }
  }

  /**
   * The file and its stale range or installed version; `null` when neither is stale or the declared
   * range cannot be judged (logged).
   */
  async #read(
    sandbox: SdkPinSandbox,
    dir: string,
    runId: string,
    log: Logger,
    signal: AbortSignal
  ): Promise<StalePin | null> {
    const read = await sandbox.call('read_file', { path: `${dir}/package.json` }, signal);
    if (read.isError) {
      log.info(
        { runId, reason: 'unreadable' },
        `${CIVITAI_SDK} pin not checked: package.json unreadable`
      );
      return null;
    }
    const pkg = manifestOf(read.text);
    const text = exactTextOf(read.text);
    if (!pkg || text === null) {
      log.warn(
        { runId, reason: pkg ? 'partial' : 'not_json' },
        `${CIVITAI_SDK} pin not checked: package.json is not JSON, or not read whole`
      );
      return null;
    }
    const check = checkSdkPin(pkg);
    if (check.kind === 'unparseable') {
      log.warn(
        { runId, reason: 'unparseable', declared: String(check.declared).slice(0, 100) },
        `${CIVITAI_SDK} pin not checked: its range in package.json cannot be read`
      );
      return null;
    }
    if (check.kind === 'absent') return null;
    const installed = await installedVersion(sandbox, dir, signal);
    const installedStale = installed !== null && installedSdkBelowFloor(installed) === true;
    if (check.kind !== 'stale' && !installedStale) return null;
    return {
      text,
      pkg,
      declared: check.declared,
      declaredStale: check.kind === 'stale',
      installedStale: installedStale ? installed : null,
      installedBefore: installed,
    };
  }

  /**
   * The upgrade's steps. No call is passed the run's Stop or the budget as an abort: a mutating call
   * cut off on the runner's side would go on in the sandbox (see `SDK_UPGRADE_TIMEOUT_MS`).
   */
  async #run(
    input: SdkUpgradeInput,
    dir: string,
    found: StalePin,
    rewritten: string
  ): Promise<string | null> {
    const { sandbox, runId, log } = input;
    const started = Date.now();
    const deadline = started + this.#upgradeTimeoutMs;
    const inTime = (stage: UpgradeFailed['stage']) => {
      if (Date.now() > deadline) throw new UpgradeFailed(stage, 'timeout');
    };
    /** How far it got: what a rollback has to undo. */
    const done = { lock: undefined as Lockfile | undefined, wrote: false, installed: false };
    let devServer: DevServerBefore = 'none';
    /** The dev server the upgrade took down to restart: a rollback starts it again the same way. */
    let restarting: DevServerBefore = 'none';
    try {
      devServer = await devServerBefore(sandbox, dir);
      done.lock = await keepLockfile(sandbox, dir).catch((error: unknown) => {
        throw error instanceof UpgradeFailed
          ? error
          : new UpgradeFailed('backup', (error as Error)?.name ?? 'error');
      });
      inTime('backup');
      if (rewritten !== found.text) {
        done.wrote = true;
        const wrote = await sandbox.call('write_file', {
          path: `${dir}/package.json`,
          content: rewritten,
        });
        if (wrote.isError) throw new UpgradeFailed('write', 'refused');
        inTime('write');
      }
      done.installed = true;
      if (!(await this.#install(input, dir))) throw new UpgradeFailed('install', 'exit_code');
      inTime('install');
      const version = await installedVersion(sandbox, dir);
      if (version === null || installedSdkBelowFloor(version) !== false)
        throw new UpgradeFailed('verify', 'still_below_floor');
      inTime('verify');
      restarting = devServer;
      if (devServer === 'here') await this.#restartHere(input);
      else if (devServer === 'elsewhere') await restartElsewhere(sandbox);
      log.info(
        {
          runId,
          declared: found.declared.slice(0, 100),
          installed: found.installedBefore?.slice(0, 100),
          version: version.slice(0, 100),
          restarted: devServer !== 'none',
          ms: Date.now() - started,
        },
        `${CIVITAI_SDK} upgraded`
      );
      return [
        `Before this reply the runner updated ${dir}'s Civitai SDK to ${TARGET_RANGE} itself and reinstalled the app's packages${
          devServer !== 'none' ? ', then restarted its dev server' : ''
        }: do not do that again.`,
        `Start your reply with this one line for the user, then go on with what they asked: ${SDK_UPGRADED_LINE}`,
        'Change no code for this upgrade unless the user asks. If the typecheck or tests fail because of the newer SDK, tell the user what broke instead of rewriting the app.',
      ].join(' ');
    } catch (error) {
      const failure =
        error instanceof UpgradeFailed
          ? error
          : new UpgradeFailed(
              restarting !== 'none' ? 'restart' : done.installed ? 'install' : 'write',
              (error as Error)?.name ?? 'error'
            );
      const rolledBack = await this.#rollBack(input, dir, found, done, restarting);
      log.warn(
        {
          runId,
          stage: failure.stage,
          reason: failure.reason,
          rolledBack,
          declared: found.declared.slice(0, 100),
          ms: Date.now() - started,
        },
        `${CIVITAI_SDK} upgrade failed`
      );
      return null;
    }
  }

  /** `cd <dir> && npm install`, told to the gates; whether it exited 0. */
  async #install(input: SdkUpgradeInput, dir: string): Promise<boolean> {
    const command = `cd ${dir} && npm install --no-audit --no-fund`;
    let result: { text: string; isError: boolean };
    try {
      result = await input.sandbox.call(
        'run_command',
        { command, timeout_ms: SDK_INSTALL_TIMEOUT_MS },
        undefined,
        { timeoutMs: SDK_INSTALL_TIMEOUT_MS + CALL_SLACK_MS }
      );
    } catch (error) {
      // No answer: it may have changed files all the same.
      input.report?.({
        name: 'sandbox__run_command',
        input: { command },
        output: { error: 'The install did not answer.' },
        isError: true,
      });
      throw error;
    }
    input.report?.({
      name: 'sandbox__run_command',
      input: { command },
      output: result.text,
      isError: result.isError,
    });
    return !result.isError && exitCodeOf(result.text) === 0;
  }

  /** The dev server of this project, stopped and started again with the shared command. */
  async #restartHere(input: SdkUpgradeInput): Promise<void> {
    const stopped = await input.sandbox.call('dev_server_stop', {});
    if (stopped.isError) throw new UpgradeFailed('restart', 'stop_refused');
    try {
      await input.startDevServer();
    } catch (error) {
      throw new UpgradeFailed('restart', (error as Error)?.name ?? 'error');
    }
  }

  /**
   * Puts the app back as it was: `package.json`'s own text and the lockfile kept before (or none, as
   * before), an install over them when one ran, which must leave the version installed before, and
   * the dev server started again when the upgrade had taken it down. Whether every step worked.
   */
  async #rollBack(
    input: SdkUpgradeInput,
    dir: string,
    found: StalePin,
    done: { lock: Lockfile | undefined; wrote: boolean; installed: boolean },
    restarting: DevServerBefore
  ): Promise<boolean> {
    const { sandbox } = input;
    let ok = true;
    try {
      if (done.wrote) {
        const wrote = await sandbox.call('write_file', {
          path: `${dir}/package.json`,
          content: found.text,
        });
        if (wrote.isError) ok = false;
      }
      if (done.installed) {
        // The kept lockfile first, so the install puts back the versions it locked; none before is
        // none after (npm writes one with every install).
        if (done.lock && 'text' in done.lock)
          ok = (await restoreLockfile(sandbox, dir, done.lock)) && ok;
        ok = (await this.#install(input, dir)) && ok;
        if (done.lock && 'absent' in done.lock)
          ok = (await restoreLockfile(sandbox, dir, done.lock)) && ok;
        ok = restoredVersion(await installedVersion(sandbox, dir), found) && ok;
      }
    } catch {
      ok = false;
    }
    // The upgrade took it down to restart it: started again, the same way, on the restored modules.
    // Stopped first: a restart that started it but timed out waiting for it to listen left it
    // running on the new modules, and a start of a running server only waits for it.
    if (restarting === 'here')
      ok = await sandbox
        .call('dev_server_stop', {})
        .then(() => input.startDevServer())
        .then(
          () => ok,
          () => false
        );
    else if (restarting === 'elsewhere')
      ok = await restartElsewhere(sandbox).then(
        () => ok,
        () => false
      );
    return ok;
  }

  #remember(key: string, pair: string, attempts: number): void {
    this.#tried.delete(key);
    this.#tried.set(key, { pair, attempts });
    if (this.#tried.size > REMEMBERED) this.#tried.delete(this.#tried.keys().next().value!);
  }
}

/**
 * Whether the SDK a rollback left is the app's own again: the version installed before, or, where
 * the install resolves the declared range afresh (no lockfile before, or a stale `node_modules`
 * under a current lockfile), a version in the declared range's own minor.
 */
function restoredVersion(version: string | null, found: StalePin): boolean {
  if (version === null) return false;
  if (version === found.installedBefore) return true;
  const minor = (value: string) => /^\D*(\d+)\.(\d+)/.exec(value)?.slice(1, 3).join('.');
  return minor(version) !== undefined && minor(version) === minor(found.declared);
}

/** `package-lock.json` as it was before the upgrade: its exact text, or that there was none. */
type Lockfile = { text: string } | { absent: true };

/**
 * Keeps the project's `package-lock.json` to put back on failure. Throws (`backup`) when it exists
 * but cannot be kept whole: the upgrade then changes nothing.
 */
async function keepLockfile(sandbox: SdkPinSandbox, dir: string): Promise<Lockfile> {
  const read = await sandbox.call('read_file', {
    path: `${dir}/package-lock.json`,
    max_bytes: LOCKFILE_MAX_BYTES,
  });
  if (!read.isError) {
    const text = exactTextOf(read.text);
    if (text === null) throw new UpgradeFailed('backup', 'lockfile_partial');
    return { text };
  }
  // Unreadable: absent, or there and unreadable, which only the shell can tell apart.
  const look = await sandbox.call('run_command', {
    command: `cd ${dir} && if [ -e package-lock.json ]; then echo present; else echo absent; fi`,
    timeout_ms: 10_000,
  });
  if (!look.isError && exitCodeOf(look.text) === 0 && outputOf(look.text).trim() === 'absent')
    return { absent: true };
  throw new UpgradeFailed('backup', 'lockfile_unreadable');
}

/** Writes the kept lockfile back, or removes the one the install made where there was none. */
async function restoreLockfile(
  sandbox: SdkPinSandbox,
  dir: string,
  lock: Lockfile
): Promise<boolean> {
  const path = `${dir}/package-lock.json`;
  if ('text' in lock)
    return !(await sandbox.call('write_file', { path, content: lock.text })).isError;
  const removed = await sandbox.call('run_command', {
    command: `cd ${dir} && rm -f package-lock.json`,
    timeout_ms: 10_000,
  });
  return !removed.isError && exitCodeOf(removed.text) === 0;
}

/**
 * `package.json` with only its `@civitai/sdk` range set to `^CIVITAI_SDK_FLOOR`, in the section
 * `checkSdkPin` reads it from (`dependencies` before `devDependencies`), written with the file's own
 * indentation, line endings and final newline. `null` when writing the file back unchanged would not
 * give its own text (inline objects, unusual spacing, escapes, duplicate keys): a rewrite would then
 * change more than the range.
 */
export function rewriteSdkRange(text: string, pkg: Record<string, unknown>): string | null {
  const crlf = text.includes('\r\n');
  const body = crlf ? text.replace(/\r\n/g, '\n') : text;
  const newline = /\n$/.test(body) ? '\n' : '';
  const indent = /^\{\n([ \t]+)"/.exec(body)?.[1] ?? '';
  const write = (value: unknown) => {
    const out = JSON.stringify(value, null, indent) + newline;
    return crlf ? out.replace(/\n/g, '\r\n') : out;
  };
  if (write(pkg) !== text) return null;
  for (const field of ['dependencies', 'devDependencies']) {
    const deps = pkg[field];
    if (deps && typeof deps === 'object' && !Array.isArray(deps) && CIVITAI_SDK in deps)
      return write({ ...pkg, [field]: { ...(deps as object), [CIVITAI_SDK]: TARGET_RANGE } });
  }
  return null;
}

/**
 * The file's text from `sandbox__read_file`'s answer, only when it is the whole file: not cut off
 * (`truncated`), and as many bytes as the file has (`size`), so writing it back restores it.
 */
function exactTextOf(answer: string): string | null {
  try {
    const read = JSON.parse(answer) as { content?: unknown; size?: unknown; truncated?: unknown };
    if (typeof read.content !== 'string' || read.truncated === true) return null;
    if (typeof read.size === 'number' && Buffer.byteLength(read.content, 'utf8') !== read.size)
      return null;
    return read.content;
  } catch {
    return null;
  }
}

/** The installed `@civitai/sdk`'s own `version`, else `null` (not installed, or unreadable). */
async function installedVersion(
  sandbox: SdkPinSandbox,
  dir: string,
  signal?: AbortSignal
): Promise<string | null> {
  try {
    const read = await sandbox.call(
      'read_file',
      { path: `${dir}/node_modules/${CIVITAI_SDK}/package.json` },
      signal
    );
    if (read.isError) return null;
    const version = manifestOf(read.text)?.version;
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
}

/**
 * Where the dev server runs: `here` when its command `cd`s into this project (restarted with the
 * shared command), `elsewhere` when it runs another way (restarted with its own command), else
 * `none` (unknown counts as none: nothing is started that was not running).
 */
async function devServerBefore(sandbox: SdkPinSandbox, dir: string): Promise<DevServerBefore> {
  try {
    const status = await sandbox.call('dev_server_status', {});
    if (status.isError) return 'none';
    const parsed = JSON.parse(status.text) as { running?: unknown } | null;
    if (parsed?.running !== true) return 'none';
    return projectDirOf(parsed) === dir ? 'here' : 'elsewhere';
  } catch {
    return 'none';
  }
}

/**
 * A dev server started some other way, restarted with its own previous command: the sandbox must say
 * it runs again. Not waited for to listen (its port is its own command's).
 */
async function restartElsewhere(sandbox: SdkPinSandbox): Promise<void> {
  const restarted = await sandbox.call('dev_server_restart', {});
  let running: unknown;
  try {
    running = (JSON.parse(restarted.text) as { running?: unknown } | null)?.running;
  } catch {
    running = undefined;
  }
  if (restarted.isError || running === false) throw new UpgradeFailed('restart', 'not_running');
}
