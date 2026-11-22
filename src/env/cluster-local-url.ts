/**
 * Whether `raw` is an http(s) URL to a cluster-local Kubernetes service host (`*.svc` or
 * `*.svc.cluster.local`), with no credentials, query or fragment. For a URL the server sends users'
 * bearer tokens to over the cluster network (`APP_DATA_SHADOW_URL`). Import-free, so the env schema
 * can use it.
 */
export function isClusterLocalServiceUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.username !== '' || u.password !== '' || u.search !== '' || u.hash !== '') return false;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  return host.endsWith('.svc') || host.endsWith('.svc.cluster.local');
}
