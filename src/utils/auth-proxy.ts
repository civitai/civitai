import type { DeviceAccountSummary } from '@civitai/auth/client';

// The main app's browser → its OWN same-origin `/api/auth/*` proxies (relative paths). Distinct from
// `@civitai/auth`, which *strictly* hub-fetches: the main app goes through proxies because it also deploys
// cross-site as `civitai.red`, where the browser can't reach the hub directly (cross-site cookies). The
// proxies are dumb pass-throughs — the gating/minting/audit lives in the hub endpoints they call.
export type { DeviceAccountSummary };

async function errorMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? fallback;
}

export const authProxy = {
  async listAccounts(): Promise<DeviceAccountSummary[]> {
    const res = await fetch('/api/auth/accounts');
    if (!res.ok) return [];
    const { accounts = [] } = (await res.json()) as { accounts?: DeviceAccountSummary[] };
    return accounts;
  },
  async switchAccount(userId: number): Promise<boolean> {
    const res = await fetch('/api/auth/switch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId }),
    });
    return res.ok;
  },
  async removeAccount(userId: number): Promise<boolean> {
    const res = await fetch(`/api/auth/accounts?userId=${userId}`, { method: 'DELETE' });
    return res.ok;
  },
  async impersonate(userId: number): Promise<void> {
    const res = await fetch('/api/auth/impersonate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId }),
    });
    if (!res.ok) throw new Error(await errorMessage(res, 'Could not impersonate'));
  },
  async exitImpersonation(): Promise<void> {
    const res = await fetch('/api/auth/impersonate', { method: 'DELETE' });
    if (!res.ok) throw new Error(await errorMessage(res, 'Could not exit impersonation'));
  },
};
