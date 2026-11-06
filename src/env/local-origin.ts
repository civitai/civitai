/**
 * A build served from a loopback origin is a developer's machine, whatever NODE_ENV says
 * (`next build && next start` is `production`). Keyed on the configured public origin, which
 * production schemas require and which a real deployment cannot point at loopback.
 * A missing or unparseable origin is local outside production (the schema leaves it optional
 * there) and not local in production, so unknown can never silence a deployment.
 */
export function isLocalOrigin(
  link: string | undefined,
  nodeEnv: string | undefined = process.env.NODE_ENV
): boolean {
  let hostname: string | undefined;
  try {
    hostname = link ? new URL(link).hostname.toLowerCase() : undefined;
  } catch {
    hostname = undefined;
  }
  if (hostname === undefined) return nodeEnv !== 'production';
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]'
  );
}

/** Analytics and ad requests leave a local origin only on an explicit `'true'` opt-in. */
export function outwardTrafficAllowed(
  link: string | undefined,
  optIn: string | undefined,
  nodeEnv?: string
) {
  return !isLocalOrigin(link, nodeEnv) || optIn === 'true';
}
