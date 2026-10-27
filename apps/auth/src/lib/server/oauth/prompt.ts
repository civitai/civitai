// The OIDC `prompt` request parameter (OIDC Core §3.1.2.1): space-separated values asking the hub to
// show, or not show, particular screens. Shared by /authorize and the consent page.

export const PROMPT_VALUES = ['none', 'login', 'consent', 'select_account'] as const;
export type PromptValue = (typeof PROMPT_VALUES)[number];

/** The prompt values a request carries. Unknown values are ignored, as OIDC allows. */
export function parsePrompt(raw: string | null | undefined): Set<PromptValue> {
  return new Set(
    (raw ?? '')
      .split(/\s+/)
      .filter((p): p is PromptValue => (PROMPT_VALUES as readonly string[]).includes(p))
  );
}
