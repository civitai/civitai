import {
  BLOCK_SLUG,
  CIVITAI_SDK,
  CIVITAI_SDK_FLOOR,
  checkSdkPin,
  installedSdkBelowFloor,
  type Sandbox,
} from '@civitai/app-assistant';
import type { ChatToolResult } from '@civitai/components-chat/runner-protocol';

import type { Logger } from '../interfaces';
import { manifestOf, projectDirOf } from './preview';

/** How long a reply's start waits for the pin check's reads: past it, the reply goes without. */
export const SDK_PIN_READ_TIMEOUT_MS = 5_000;
/**
 * The sandbox's own bound on the upgrade's `npm install` (its `timeout_ms`: the sandbox kills the
 * install's whole process group past it). An App Block has a handful of dependencies and keeps its
 * `node_modules` across a pause, so bumping one of them is an install of seconds to a few tens of
 * seconds; 90 s leaves room for a cold npm cache without letting a wedged registry hold the reply.
 */
export const SDK_INSTALL_TIMEOUT_MS = 90_000;
/**
 * The whole upgrade's budget (the rewrite, the install, reading the installed version, and the dev
 * server's restart, which waits up to `DEV_SERVER_WAIT_MS` to listen): past it the upgrade is
 * abandoned (the call in flight is cancelled, which kills it in the sandbox) and rolled back.
 */
export const SDK_UPGRADE_TIMEOUT_MS = 120_000;
/**
 * The rollback's own budget, apart from the upgrade's: an install cut short leaves `node_modules`
 * half-changed, and an app left that way is worse than a slower first reply, so putting it back gets
 * the same room as the upgrade had.
 */
export const SDK_ROLLBACK_TIMEOUT_MS = 120_000;
/** How long one MCP call waits past the sandbox's own bound on its command, for its answer. */
const CALL_SLACK_MS = 10_000;
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
  readonly active: Pick<Sandbox, 'app' | 'state'> | null;
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
  constructor(readonly stage: 'write' | 'install' | 'verify' | 'restart', readonly reason: string) {
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
  installed: string | null;
}

export interface SdkUpgradeInput {
  sandbox: SdkPinSandbox;
  /** Whether the sandbox listed a tool (by its own name, `run_command`): its MCP server answers it. */
  hasTool(name: string): boolean;
  /** Starts the app's dev server with the shared command and waits for it to listen (`RunnerPreview.startDevServer`). */
  startDevServer(signal: AbortSignal): Promise<void>;
  /** Tells the reply's gates (the runner's and the page's) of the install, as of any command run. */
  report?(result: ChatToolResult): void;
  conversationId: string;
  runId: string;
  log: Logger;
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
 * 1. only the `@civitai/sdk` range is set to `^CIVITAI_SDK_FLOOR`, in the section it is in, the file
 *    otherwise byte for byte as it was (a layout a rewrite would not keep is left alone);
 * 2. `cd <app key> && npm install`, which brings the lockfile and `node_modules` to the new range and
 *    keeps every other locked version;
 * 3. the installed version is read again: it must be at the floor now;
 * 4. a dev server that was running in that project is restarted with the shared command.
 *
 * Any failure, or the budget (`SDK_UPGRADE_TIMEOUT_MS`) running out, puts `package.json` back as it
 * was, installs again when an install began, and starts the dev server again if it was running; it
 * is logged, and the reply goes on. Each app gets `ATTEMPTS` tries per conversation for one
 * (declared, installed) pair, so a broken app is not installed into every turn. Kept in this
 * process's memory: a restarted runner may try once more.
 *
 * Fails open, changing nothing: an app that is not running or listed no tools, an unusual app key,
 * a sandbox without `run_command` or `write_file`, an unreadable or unparseable `package.json`, a
 * range it cannot read, or reads past `SDK_PIN_READ_TIMEOUT_MS`. Nothing here throws.
 *
 * Assumed, as for the page's Restart preview: no other reply works in this app meanwhile (another
 * conversation about the same app, at the same moment).
 */
export class SdkUpgrades {
  /** `conversation \n app` → the (declared, installed) pair last tried, and how often. */
  readonly #tried = new Map<string, { pair: string; attempts: number }>();
  readonly #readTimeoutMs: number;
  readonly #upgradeTimeoutMs: number;
  readonly #rollbackTimeoutMs: number;

  constructor(
    options: { readTimeoutMs?: number; upgradeTimeoutMs?: number; rollbackTimeoutMs?: number } = {}
  ) {
    this.#readTimeoutMs = options.readTimeoutMs ?? SDK_PIN_READ_TIMEOUT_MS;
    this.#upgradeTimeoutMs = options.upgradeTimeoutMs ?? SDK_UPGRADE_TIMEOUT_MS;
    this.#rollbackTimeoutMs = options.rollbackTimeoutMs ?? SDK_ROLLBACK_TIMEOUT_MS;
  }

  /**
   * Upgrades the open app when its SDK is stale; resolves with what the reply's instructions get
   * after an upgrade (the line to tell the user), else `null`.
   */
  async upgrade(input: SdkUpgradeInput): Promise<string | null> {
    const { sandbox, conversationId, runId, log } = input;
    const app = sandbox.active;
    if (!app || app.state !== 'running' || !input.hasTool('read_file')) return null;
    const dir = app.app;
    // The project directory goes into a shell command: an app key only.
    if (!BLOCK_SLUG.test(dir)) {
      log.info({ runId, reason: 'app_key' }, `${CIVITAI_SDK} pin not checked: unusual app key`);
      return null;
    }
    const found = await this.#check(input, dir);
    if (!found) return null;

    const key = `${conversationId}\n${dir}`;
    const pair = `${found.declared}\n${found.installed ?? ''}`;
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
      installed: installedStale ? installed : null,
    };
  }

  async #run(
    input: SdkUpgradeInput,
    dir: string,
    found: StalePin,
    rewritten: string
  ): Promise<string | null> {
    const { sandbox, runId, log } = input;
    const started = Date.now();
    const stop = new AbortController();
    const abort = () => stop.abort();
    input.signal?.addEventListener('abort', abort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      stop.abort();
    }, this.#upgradeTimeoutMs);
    const signal = stop.signal;
    /** How far it got: what a rollback has to undo. */
    const done = { wrote: false, installing: false, stoppedDevServer: false };
    let devServerWasRunning = false;
    try {
      devServerWasRunning = await devServerRunsIn(sandbox, dir, signal);
      if (rewritten !== found.text) {
        done.wrote = true;
        const wrote = await sandbox.call(
          'write_file',
          { path: `${dir}/package.json`, content: rewritten },
          signal
        );
        if (wrote.isError) throw new UpgradeFailed('write', 'refused');
      }
      done.installing = true;
      const installed = await this.#install(input, dir, signal);
      if (!installed) throw new UpgradeFailed('install', 'exit_code');
      const version = await installedVersion(sandbox, dir, signal);
      if (version === null || installedSdkBelowFloor(version) !== false)
        throw new UpgradeFailed('verify', 'still_below_floor');
      if (devServerWasRunning) {
        done.stoppedDevServer = true;
        await this.#restartDevServer(input, signal);
      }
      log.info(
        {
          runId,
          declared: found.declared.slice(0, 100),
          installed: found.installed?.slice(0, 100),
          version: version.slice(0, 100),
          restarted: devServerWasRunning,
          ms: Date.now() - started,
        },
        `${CIVITAI_SDK} upgraded`
      );
      return [
        `Before this reply the runner updated ${dir}'s Civitai SDK to ${TARGET_RANGE} itself and reinstalled the app's packages${
          devServerWasRunning ? ', then restarted its dev server' : ''
        }: there is nothing left to do for it.`,
        `Start your reply with this one line for the user, then go on with what they asked: ${SDK_UPGRADED_LINE}`,
      ].join(' ');
    } catch (error) {
      const failure =
        error instanceof UpgradeFailed
          ? error
          : new UpgradeFailed(
              done.stoppedDevServer ? 'restart' : done.installing ? 'install' : 'write',
              timedOut ? 'timeout' : signal.aborted ? 'stopped' : (error as Error)?.name ?? 'error'
            );
      const rolledBack = await this.#rollBack(input, dir, found.text, done);
      log.warn(
        {
          runId,
          stage: failure.stage,
          reason: timedOut ? 'timeout' : failure.reason,
          rolledBack,
          declared: found.declared.slice(0, 100),
          ms: Date.now() - started,
        },
        `${CIVITAI_SDK} upgrade failed`
      );
      return null;
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', abort);
      stop.abort();
    }
  }

  /** `cd <dir> && npm install`, told to the gates; whether it exited 0. */
  async #install(input: SdkUpgradeInput, dir: string, signal: AbortSignal): Promise<boolean> {
    const command = `cd ${dir} && npm install --no-audit --no-fund`;
    let result: { text: string; isError: boolean };
    try {
      result = await input.sandbox.call(
        'run_command',
        { command, timeout_ms: SDK_INSTALL_TIMEOUT_MS },
        signal,
        { timeoutMs: SDK_INSTALL_TIMEOUT_MS + CALL_SLACK_MS }
      );
    } catch (error) {
      // Cut off: it may have changed files all the same.
      input.report?.({
        name: 'sandbox__run_command',
        input: { command },
        output: { error: 'The install did not finish.' },
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
    return !result.isError && /^exit_code: 0\b/.test(result.text);
  }

  async #restartDevServer(input: SdkUpgradeInput, signal: AbortSignal): Promise<void> {
    const stopped = await input.sandbox.call('dev_server_stop', {}, signal);
    if (stopped.isError) throw new UpgradeFailed('restart', 'stop_refused');
    try {
      await input.startDevServer(signal);
    } catch (error) {
      throw new UpgradeFailed('restart', (error as Error)?.name ?? 'error');
    }
  }

  /**
   * Puts the app back as it was: `package.json`'s own text, an install over it when one began, and
   * the dev server started again when the upgrade had stopped it. Its own budget, apart from the upgrade's and
   * the run's (a Stop still leaves the app whole). Whether every step worked.
   */
  async #rollBack(
    input: SdkUpgradeInput,
    dir: string,
    original: string,
    done: { wrote: boolean; installing: boolean; stoppedDevServer: boolean }
  ): Promise<boolean> {
    const { sandbox } = input;
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), this.#rollbackTimeoutMs);
    const signal = stop.signal;
    try {
      if (done.wrote) {
        const wrote = await sandbox.call(
          'write_file',
          { path: `${dir}/package.json`, content: original },
          signal
        );
        if (wrote.isError) return false;
      }
      let ok = true;
      if (done.installing) ok = await this.#install(input, dir, signal);
      // The upgrade stopped it to restart it: started again, on the restored modules.
      if (done.stoppedDevServer) await input.startDevServer(signal);
      return ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
      stop.abort();
    }
  }

  #remember(key: string, pair: string, attempts: number): void {
    this.#tried.delete(key);
    this.#tried.set(key, { pair, attempts });
    if (this.#tried.size > REMEMBERED) this.#tried.delete(this.#tried.keys().next().value!);
  }
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
  signal: AbortSignal
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
 * Whether the dev server runs, in this project (the directory its command `cd`s into): one running
 * another project's is not this upgrade's to restart. Unknown counts as no.
 */
async function devServerRunsIn(
  sandbox: SdkPinSandbox,
  dir: string,
  signal: AbortSignal
): Promise<boolean> {
  try {
    const status = await sandbox.call('dev_server_status', {}, signal);
    if (status.isError) return false;
    const parsed = JSON.parse(status.text) as { running?: unknown } | null;
    return parsed?.running === true && projectDirOf(parsed) === dir;
  } catch {
    return false;
  }
}
