import {
  BLOCK_SLUG,
  CIVITAI_SDK,
  checkSdkPin,
  sdkUpgradeInstruction,
  type Sandbox,
} from '@civitai/app-assistant';

import type { Logger } from '../interfaces';
import { manifestOf } from './preview';

/** How long a reply's start waits for the app's `package.json`: past it, the reply goes without. */
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

/**
 * The runner's check, as a reply opens, of the app's `@civitai/sdk` pin (its `<app key>/package.json`,
 * read with the sandbox's own `read_file`): a stale one adds `sdkUpgradeInstruction` to that reply's
 * instructions. Once per app per conversation for the same declared range, so it never repeats every
 * turn; a changed range that is still stale is told once more. Kept in this process's memory: a
 * restarted runner may tell a conversation once more.
 *
 * Fails open: an app that is not running, an unreadable or unparseable `package.json`, or a range it
 * cannot read gives no instruction (logged), and nothing here throws.
 */
export class SdkPinNudges {
  /** `conversation \n app` → the declared range it was last told about. */
  readonly #told = new Map<string, string>();
  readonly #timeoutMs: number;

  constructor(options: { timeoutMs?: number } = {}) {
    this.#timeoutMs = options.timeoutMs ?? SDK_PIN_READ_TIMEOUT_MS;
  }

  async instruction(input: {
    sandbox: SdkPinSandbox;
    conversationId: string;
    runId: string;
    log: Logger;
    signal?: AbortSignal;
  }): Promise<string | null> {
    const { sandbox, conversationId, runId, log } = input;
    const app = sandbox.active;
    if (!app || app.state !== 'running') return null;
    const dir = app.app;
    // The project directory goes into a command the assistant is told to run: an app key only.
    if (!BLOCK_SLUG.test(dir)) {
      log.info({ runId, reason: 'app_key' }, `${CIVITAI_SDK} pin not checked: unusual app key`);
      return null;
    }
    const path = `${dir}/package.json`;
    try {
      const timeout = AbortSignal.timeout(this.#timeoutMs);
      const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
      const read = await sandbox.call('read_file', { path }, signal);
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
      if (check.kind !== 'stale') return null;
      const key = `${conversationId}\n${app.app}`;
      if (this.#told.get(key) === check.declared) return null;
      this.#remember(key, check.declared);
      log.info({ runId, declared: check.declared.slice(0, 100) }, `${CIVITAI_SDK} upgrade nudged`);
      return sdkUpgradeInstruction(dir, check.declared);
    } catch (error) {
      log.info(
        { runId, reason: 'read_failed', err: (error as Error)?.name },
        `${CIVITAI_SDK} pin not checked: reading package.json failed`
      );
      return null;
    }
  }

  #remember(key: string, declared: string): void {
    this.#told.delete(key);
    this.#told.set(key, declared);
    if (this.#told.size > REMEMBERED) this.#told.delete(this.#told.keys().next().value!);
  }
}
