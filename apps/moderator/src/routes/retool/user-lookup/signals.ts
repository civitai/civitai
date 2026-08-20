// The `/api/user-signals` payload, declared once. Retool split this data across four nav sections
// (Socials & Bio, Prompt Audit, Image Generation, Chat) but it is one endpoint, so the section page
// fetches it once and hands the promise to whichever panels the section renders.
//
// Declared here rather than imported from `$lib/server/*`: it crosses a JSON boundary, so `Date`
// arrives as `string`, and importing a server module into a component invites it into the client bundle.

export type LinkedAccount = {
  userId: number;
  username: string | null;
  bannedAt: string | null;
  muted: boolean | null;
  strikes: number;
};

export type Signals = {
  commentBurst: number;
  ips: {
    addresses: { ip: string; type: string; first: string; last: string; events: number }[];
    accounts: (LinkedAccount & { ip: string; type: string; last: string })[];
    truncated: boolean;
  };
  socials: {
    links: { id: number; url: string; type: string }[];
    accounts: (LinkedAccount & { url: string })[];
    truncated: boolean;
  };
  generation: {
    blocked: {
      key: string;
      time: string;
      prompt: string;
      negativePrompt: string | null;
      source: string;
    }[];
    blockedTotal: number;
    last24h: number;
  };
  events: {
    key: string;
    type: string;
    time: string;
    actorId: number | null;
    actor: string | null;
  }[];
};

export async function fetchSignals(userId: number, version: number): Promise<Signals> {
  const r = await fetch(`/api/user-signals/${userId}?v=${version}`);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

/** Social URLs are user-controlled and Svelte does not sanitise hrefs, so a `javascript:` link would
 *  execute in a moderator's session. Anything that is not plain http(s) renders as text. */
export const safeHref = (url: string) => (/^https?:\/\//i.test(url.trim()) ? url : null);
