import { ipCluster } from './ip-clusters';

const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
// Loose on purpose: every candidate is confirmed by `ipCluster`, so a time like `12:30:45` survives.
const IPV6ISH = /(?<![0-9a-f:])[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}(?:\/\d{1,3})?/gi;

/**
 * Free text (a tool request, a playbook draft, an answer) with every IP address replaced by
 * `[address]`, for a viewer who could not read addresses in User Lookup. The assistant writes the
 * addresses it was shown into these, so text one moderator could read can reach one who could not.
 */
export const redactAddresses = (text: string): string =>
  text
    .replace(IPV4, (m) => (ipCluster(m) ? '[address]' : m))
    .replace(IPV6ISH, (m) => {
      const bare = m.replace(/\/\d{1,3}$/, '');
      return bare.includes(':') && ipCluster(bare) ? '[address]' : m;
    });
