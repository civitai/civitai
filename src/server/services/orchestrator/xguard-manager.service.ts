/**
 * XGuard policy management — orchestrator-side admin API for the per-label
 * policies that drive XGuard moderation decisions.
 *
 * Each label's policy is the natural-language prompt text + threshold + action
 * the orchestrator applies when evaluating an XGuard call. See
 * docs/features/scanner-prompt-tuning.md for the broader lifecycle. New PUTs
 * cause the orchestrator to stamp a new `policyHash` on subsequent results,
 * which lights up A/B comparison in our audit log.
 *
 * These endpoints aren't part of the @civitai/orchestration-client SDK, so we hit them with
 * plain fetch + Bearer auth. Admin operations — failures throw.
 */
import { env } from '~/env/server';

export type XGuardMode = 'text' | 'prompt';
export type XGuardOptions = unknown;
export type XGuardExport = unknown;

async function call<T>(method: 'GET' | 'PUT' | 'POST', path: string, body?: unknown): Promise<T> {
  const endpoint = env.ORCHESTRATOR_ENDPOINT;
  const token = env.ORCHESTRATOR_ACCESS_TOKEN;
  if (!endpoint) throw new Error('Missing ORCHESTRATOR_ENDPOINT env');
  if (!token) throw new Error('Missing ORCHESTRATOR_ACCESS_TOKEN env');

  const res = await fetch(`${endpoint}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `XGuard manager ${method} ${path} failed (${res.status}): ${text.slice(0, 500)}`
    );
  }
  return (await res.json()) as T;
}

export const getXGuardOptions = (mode: XGuardMode) =>
  call<XGuardOptions>('GET', `/v1/manager/xguard/options/${mode}`);

export const getXGuardDefaults = (mode: XGuardMode) =>
  call<XGuardOptions>('GET', `/v1/manager/xguard/options/${mode}/defaults`);

export const putXGuardOptions = (mode: XGuardMode, options: XGuardOptions) =>
  call<XGuardOptions>('PUT', `/v1/manager/xguard/options/${mode}`, options);

export const resetXGuardOptions = (mode: XGuardMode) =>
  call<XGuardOptions>('POST', `/v1/manager/xguard/options/${mode}/reset`, {});

export const exportXGuardOptions = () => call<XGuardExport>('GET', '/v1/manager/xguard/export');

export const importXGuardOptions = (payload: XGuardExport) =>
  call<XGuardExport>('PUT', '/v1/manager/xguard/import', payload);
