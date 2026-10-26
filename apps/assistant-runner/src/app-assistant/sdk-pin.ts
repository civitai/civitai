import {
  BLOCK_SLUG,
  CIVITAI_SDK,
  checkSdkPin,
  installedSdkBelowFloor,
  sdkUpgradeInstruction,
  type Sandbox,
} from '@civitai/app-assistant';

import type { Logger } from '../interfaces';
import { manifestOf } from './preview';

/** How long a reply's start waits for the pin check's reads: past it, the reply goes without. */
export const SDK_PIN_READ_TIMEOUT_MS = 5_000;
/** The most conversations whose nudge is remembered; the oldest is forgotten past it. */
const REMEMBERED = 10_000;

export interface SdkPinSandbox {
  readonly active: Pick<Sandbox, 'app' | 'state'> | null;
  call(
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<{ text: string; isError: boolean }>;
}

class PinReadTimeout extends Error {
  override name = 'PinReadTimeout';
}

/**
 * The runner's check, as a reply opens, of the app's `@civitai/sdk`: the range its
 * `<app key>/package.json` declares and the version installed in its `node_modules`, read with the
 * sandbox's own `read_file`. Either below the floor adds `sdkUpgradeInstruction` to that reply's
 * instructions. Once per app per conversation for the same (declared, installed) pair, so it never
 * repeats every turn; a changed pair that is still stale (a bumped range whose install did not
 * finish) is told once more. Kept in this process's memory: a restarted runner may tell a
 * conversation once more.
 *
 * Fails open: an app that is not running or listed no tools (its MCP server is not answering), an
 * unreadable or unparseable `package.json`, a range it cannot read, or reads past the timeout give
 * no instruction (logged), and nothing here throws. A missing installed SDK leaves the declared
 * range to decide.
 */
export class SdkPinNudges {
  /** `conversation \n app` → the (declared, installed) pair it was last told about. */
  readonly #told = new Map<string, string>();
  readonly #timeoutMs: number;

  constructor(options: { timeoutMs?: number } = {}) {
    this.#timeoutMs = options.timeoutMs ?? SDK_PIN_READ_TIMEOUT_MS;
  }

  async instruction(input: {
    sandbox: SdkPinSandbox;
    /** The sandbox listed its tools for this reply: without them its MCP server is not answering. */
    toolsListed: boolean;
    conversationId: string;
    runId: string;
    log: Logger;
    signal?: AbortSignal;
  }): Promise<string | null> {
    const { sandbox, conversationId, runId, log } = input;
    const app = sandbox.active;
    if (!app || app.state !== 'running' || !input.toolsListed) return null;
    const dir = app.app;
    // The project directory goes into a command the assistant is told to run: an app key only.
    if (!BLOCK_SLUG.test(dir)) {
      log.info({ runId, reason: 'app_key' }, `${CIVITAI_SDK} pin not checked: unusual app key`);
      return null;
    }
    // The whole check is bounded, not only each call: a call first waits for the MCP connection.
    const stop = new AbortController();
    const abort = () => stop.abort();
    input.signal?.addEventListener('abort', abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        stop.abort();
        reject(new PinReadTimeout());
      }, this.#timeoutMs);
    });
    try {
      const found = await Promise.race([
        this.#read(sandbox, dir, runId, log, stop.signal),
        timedOut,
      ]);
      if (!found) return null;
      const key = `${conversationId}\n${app.app}`;
      const pair = `${found.declared}\n${found.installed ?? ''}`;
      if (this.#told.get(key) === pair) return null;
      this.#remember(key, pair);
      log.info(
        {
          runId,
          declared: found.declared.slice(0, 100),
          installed: found.installed?.slice(0, 100),
        },
        `${CIVITAI_SDK} upgrade nudged`
      );
      return sdkUpgradeInstruction(dir, found.declared, undefined, found.installed);
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
   * The declared range, and the installed version when it is below the floor too; `null` when
   * neither is stale or the declared range cannot be judged (logged).
   */
  async #read(
    sandbox: SdkPinSandbox,
    dir: string,
    runId: string,
    log: Logger,
    signal: AbortSignal
  ): Promise<{ declared: string; installed?: string } | null> {
    const read = await sandbox.call('read_file', { path: `${dir}/package.json` }, signal);
    if (read.isError) {
      log.info(
        { runId, reason: 'unreadable' },
        `${CIVITAI_SDK} pin not checked: package.json unreadable`
      );
      return null;
    }
    const pkg = manifestOf(read.text);
    if (!pkg) {
      log.warn(
        { runId, reason: 'not_json' },
        `${CIVITAI_SDK} pin not checked: package.json is not JSON`
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
    const installed = await this.#installed(sandbox, dir, signal);
    const installedStale = installed !== null && installedSdkBelowFloor(installed) === true;
    if (check.kind !== 'stale' && !installedStale) return null;
    return { declared: check.declared, ...(installedStale ? { installed: installed! } : {}) };
  }

  /** The installed `@civitai/sdk`'s own `version`, else `null` (not installed, or unreadable). */
  async #installed(
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

  #remember(key: string, pair: string): void {
    this.#told.delete(key);
    this.#told.set(key, pair);
    if (this.#told.size > REMEMBERED) this.#told.delete(this.#told.keys().next().value!);
  }
}
