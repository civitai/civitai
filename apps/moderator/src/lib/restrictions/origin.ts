export type PromptMatch = 'identical' | 'edited' | 'unrelated' | 'unknown';

/** Where a blocked prompt came from, as recorded when it was blocked. An empty object means it was looked for and nothing was found; absent means it was never looked for. */
export type TriggerOrigin = {
  /** A lookup failed, so whatever evidence is present is partial and its absence proves nothing. */
  incomplete?: true;
  remix?: {
    imageId: number;
    /** Confirmed by the server, as opposed to the client's own claim of a remix source. */
    verified: boolean;
    promptMatch: PromptMatch;
    score?: number;
  };
  enhancer?: {
    workflowId: string;
    /** Whether the enhancer output it was matched against was confirmed server-side. */
    verified: boolean;
    promptMatch: 'identical' | 'edited';
  };
};

type OriginInput = {
  prompt?: string;
  /** Present on triggers that scanned text rather than a generation prompt. */
  text?: string;
  category?: string;
  remixOfId?: number | null;
  origin?: TriggerOrigin;
};

export type OriginView = {
  /** `none` is a trigger that is not a generation prompt, so "typed by the user" would be false.
   *  `unrecorded` predates origin tracking, so nothing is known about where the prompt came from.
   *  `incomplete` is a prompt whose origin lookup failed and found nothing, so "typed" would be a guess. */
  kind: 'remix' | 'legacy-remix' | 'enhancer' | 'typed' | 'unrecorded' | 'incomplete' | 'none';
  label: string;
  verified: boolean;
  match: PromptMatch;
  /** The lookup failed; any evidence shown is partial. */
  incomplete: boolean;
  imageId?: number;
  /** A remix that also carries enhancer evidence. */
  alsoEnhancer: boolean;
  /** Whether that enhancer evidence was confirmed server-side; false when there is none. */
  enhancerVerified: boolean;
};

const MATCH_WORDS: Record<PromptMatch, string> = {
  identical: 'unchanged',
  edited: 'edited',
  unrelated: 'unrelated',
  unknown: 'not compared',
};

export function triggerOrigin(trigger: OriginInput): OriginView {
  const { origin } = trigger;
  const alsoEnhancer = !!origin?.enhancer;
  const enhancerVerified = origin?.enhancer?.verified === true;
  const incomplete = !!origin?.incomplete;

  if (origin?.remix) {
    const { imageId, verified, promptMatch } = origin.remix;
    return {
      kind: 'remix',
      label: `Remix of #${imageId} · ${MATCH_WORDS[promptMatch]}`,
      verified,
      match: promptMatch,
      incomplete,
      imageId,
      alsoEnhancer,
      enhancerVerified,
    };
  }
  if (origin?.enhancer) {
    const { promptMatch } = origin.enhancer;
    return {
      kind: 'enhancer',
      label: `Prompt enhancer output · ${MATCH_WORDS[promptMatch]}`,
      verified: origin.enhancer.verified === true,
      match: promptMatch,
      incomplete,
      alsoEnhancer: false,
      enhancerVerified: false,
    };
  }
  if (trigger.remixOfId && trigger.remixOfId > 0) {
    return {
      kind: 'legacy-remix',
      label: `Remix of #${trigger.remixOfId} · ${MATCH_WORDS.unknown}`,
      verified: false,
      match: 'unknown',
      incomplete,
      imageId: trigger.remixOfId,
      alsoEnhancer: false,
      enhancerVerified: false,
    };
  }
  if (trigger.prompt) {
    const kind = !origin ? 'unrecorded' : incomplete ? 'incomplete' : 'typed';
    return {
      kind,
      label: {
        unrecorded: 'Origin not recorded',
        incomplete: 'Origin lookup incomplete',
        typed: 'Typed by user',
      }[kind],
      verified: false,
      match: 'unknown',
      incomplete,
      alsoEnhancer: false,
      enhancerVerified: false,
    };
  }
  return {
    kind: 'none',
    label: '',
    verified: false,
    match: 'unknown',
    incomplete: false,
    alsoEnhancer: false,
    enhancerVerified: false,
  };
}

type Tally = {
  total: number;
  unchanged: number;
  edited: number;
  unrelated: number;
  unconfirmed: number;
  enhancer: number;
  enhancerUnconfirmed: number;
  typed: number;
  unrecorded: number;
  /** Prompts whose lookup failed and found nothing. */
  incomplete: number;
  /** Prompts that carry evidence but whose lookup also failed part-way. */
  partial: number;
};

function tally(triggers: readonly OriginInput[]): Tally {
  const t: Tally = {
    total: 0,
    unchanged: 0,
    edited: 0,
    unrelated: 0,
    unconfirmed: 0,
    enhancer: 0,
    enhancerUnconfirmed: 0,
    typed: 0,
    unrecorded: 0,
    incomplete: 0,
    partial: 0,
  };
  for (const trigger of triggers) {
    const view = triggerOrigin(trigger);
    if (view.kind === 'none') continue;
    t.total++;
    if (view.incomplete && view.kind !== 'incomplete') t.partial++;
    if (view.kind === 'enhancer') view.verified ? t.enhancer++ : t.enhancerUnconfirmed++;
    else if (view.kind === 'typed') t.typed++;
    else if (view.kind === 'unrecorded') t.unrecorded++;
    else if (view.kind === 'incomplete') t.incomplete++;
    // Only a server-confirmed source may be reported as one; a claimed source stays unconfirmed
    // whatever the prompt comparison said.
    else if (!view.verified) t.unconfirmed++;
    else if (view.match === 'identical') t.unchanged++;
    else if (view.match === 'edited') t.edited++;
    else if (view.match === 'unrelated') t.unrelated++;
    else t.unconfirmed++;
  }
  return t;
}

/** The one-line verdict for a restriction and the short chip for its queue row. */
export function originSummary(triggers: readonly OriginInput[]): {
  verdict: string | null;
  chip: string;
} {
  const t = tally(triggers);
  if (t.total === 0) return { verdict: null, chip: '' };

  const remix = t.unchanged + t.edited + t.unrelated;
  const chip = [
    remix && `${remix} remix`,
    t.unconfirmed && `${t.unconfirmed} remix (unconfirmed)`,
    t.enhancer && `${t.enhancer} enhancer`,
    t.enhancerUnconfirmed && `${t.enhancerUnconfirmed} enhancer (unconfirmed)`,
    t.typed && `${t.typed} typed`,
    t.unrecorded && `${t.unrecorded} not recorded`,
    t.incomplete && `${t.incomplete} incomplete`,
  ]
    .filter(Boolean)
    .join(' · ');

  const one = t.total === 1;
  const prompts = one ? 'the blocked prompt' : `${t.total} blocked prompts`;

  if (t.unrecorded === t.total)
    return {
      chip,
      verdict: `Origin not recorded for ${prompts} (recorded before origin tracking)`,
    };

  if (t.incomplete === t.total) return { chip, verdict: `Origin lookup incomplete for ${prompts}` };

  if (t.typed === t.total)
    return {
      chip,
      verdict: one
        ? 'The blocked prompt was typed by the user'
        : `All ${t.total} blocked prompts were typed by the user`,
    };

  const remixes = one ? 'a remix' : 'remixes';
  const leads: [number, string][] = [
    [t.unchanged, `came from ${remixes} and ${one ? 'was' : 'were'} left unchanged`],
    [t.edited, `came from ${remixes} and ${one ? 'was' : 'were'} edited`],
    [t.unrelated, 'had a remix source but an unrelated prompt'],
    [t.unconfirmed, `came from ${remixes} that could not be confirmed`],
    [t.enhancer, 'came from the prompt enhancer'],
    [t.enhancerUnconfirmed, 'matched a prompt enhancer output that could not be confirmed'],
  ];
  const lead = leads.findIndex(([count]) => count > 0);
  const tail = [
    t.typed && `${t.typed} typed`,
    t.unrecorded && `${t.unrecorded} not recorded`,
    t.incomplete && `${t.incomplete} origin lookup incomplete`,
  ];

  if (lead < 0) {
    const typedLead = t.typed > 0;
    const rest = [
      t.unrecorded && `${t.unrecorded} not recorded`,
      t.incomplete && `${t.incomplete} origin lookup incomplete`,
    ].filter(Boolean);
    return {
      chip,
      verdict: typedLead
        ? `${t.typed} of ${t.total} blocked ${
            one ? 'prompt was' : 'prompts were'
          } typed by the user (${rest.join(', ')})`
        : `Origin unknown for ${prompts} (${rest.join(', ')})`,
    };
  }
  const [count, phrase] = leads[lead];

  const rest = [
    lead < 1 && t.edited && `${t.edited} edited remix`,
    lead < 2 && t.unrelated && `${t.unrelated} with a remix source but an unrelated prompt`,
    lead < 3 && t.unconfirmed && `${t.unconfirmed} unconfirmed remix`,
    lead < 4 && t.enhancer && `${t.enhancer} enhancer output`,
    lead < 5 && t.enhancerUnconfirmed && `${t.enhancerUnconfirmed} unconfirmed enhancer output`,
    ...tail,
    t.partial && `${t.partial} origin lookup incomplete`,
  ].filter(Boolean);

  return {
    chip,
    verdict:
      `${count} of ${t.total} blocked ${one ? 'prompt' : 'prompts'} ${phrase}` +
      (rest.length ? ` (${rest.join(', ')})` : ''),
  };
}

/** Cap on source images read for one page, so a page with many triggers stays one small query. */
const REMIX_SOURCE_LIMIT = 300;

/**
 * The distinct image ids the triggers name as remix sources (the recorded origin first, the legacy field
 * otherwise), split into those to look up and those the cap left out. The second list is what lets the
 * card say "not loaded" rather than claim an image was deleted.
 */
export function planRemixSources(rows: readonly { triggers: readonly OriginInput[] }[]): {
  lookup: number[];
  notLoaded: number[];
} {
  const ids = new Set<number>();
  for (const row of rows)
    for (const trigger of row.triggers) {
      const id = triggerOrigin(trigger).imageId;
      if (id) ids.add(id);
    }
  const all = [...ids];
  return { lookup: all.slice(0, REMIX_SOURCE_LIMIT), notLoaded: all.slice(REMIX_SOURCE_LIMIT) };
}

export type SourceState = 'loaded' | 'failed' | 'not-loaded' | 'missing';

/** `missing` is claimed only for an id that was looked up successfully and came back absent. */
export function sourceState(
  id: number,
  lookup: { sources: Record<number, unknown>; failed: boolean; notLoaded: readonly number[] }
): SourceState {
  if (lookup.sources[id]) return 'loaded';
  if (lookup.notLoaded.includes(id)) return 'not-loaded';
  return lookup.failed ? 'failed' : 'missing';
}
