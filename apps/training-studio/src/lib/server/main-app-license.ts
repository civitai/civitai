import { mainAppSessionOrigin } from './main-app';

const TIMEOUT_MS = 10_000;

const licenseUrl = () => `${mainAppSessionOrigin()}/api/training-studio/license`;

/** The training ecosystems whose base model licence this user has yet to accept, asked as the user. */
export async function mainAppPendingLicenses(cookie: string): Promise<string[]> {
  const res = await fetch(licenseUrl(), {
    headers: { cookie },
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => null)) as { pending?: unknown } | null;
  if (!res.ok || !Array.isArray(body?.pending))
    throw new Error(`The licence check failed (${res.status}).`);
  return body.pending.filter((eco): eco is string => typeof eco === 'string');
}

/** Record this user's acceptance of the licence of the model `ecosystem` trains. */
export async function mainAppAcceptLicense(cookie: string, ecosystem: string): Promise<void> {
  const res = await fetch(licenseUrl(), {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ ecosystem }),
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Could not record the licence acceptance (${res.status}).`);
}
