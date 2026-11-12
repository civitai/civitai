/**
 * Licences a user must accept, once, before generating with an ecosystem. Each acceptance is
 * recorded on the user (`settings.generationLicenseAcceptances[key]`) with the terms version, and
 * the generate path refuses a submission without it. Bump `version` when the wording changes, so
 * everyone is asked again for the new text.
 */
export type GenerationLicenseTerms = {
  key: string;
  version: number;
  ecosystems: readonly string[];
  title: string;
  licenseName: string;
  licenseUrl: string;
  intro: string;
  /** Each is shown as its own line and must stand alone. */
  restrictions: readonly string[];
};

export const GENERATION_LICENSE_TERMS: readonly GenerationLicenseTerms[] = [
  {
    key: 'minimax-h3-image-community-license',
    version: 1,
    ecosystems: ['MiniMaxH3Image'],
    title: 'MiniMax-H3-Image licence terms',
    licenseName:
      'MiniMax-H3-Image Community License Agreement, including its Acceptable Use Policy',
    // Pinned to the 10 Nov 2026 revision, so the terms accepted stay the terms linked.
    licenseUrl:
      'https://huggingface.co/MiniMaxAI/MiniMax-H3-Image/blob/492fd8c4eca666f1085f57e30738c1e0d86b3439/LICENSE',
    intro:
      'MiniMax-H3-Image is licensed under the MiniMax-H3-Image Community License Agreement, Copyright © 2026 MiniMax. All Rights Reserved. When you generate with it, its use restrictions (Section V) and Acceptable Use Policy (Exhibit A) apply to you, except the territory limits in Section V.4 and Exhibit A item 1, which are not part of these terms.',
    restrictions: [
      'You will follow those use restrictions and the Acceptable Use Policy.',
      'You may not use MiniMax-H3-Image or anything it generates to improve any other AI model.',
    ],
  },
];

const termsByEcosystem = new Map(
  GENERATION_LICENSE_TERMS.flatMap((terms) => terms.ecosystems.map((eco) => [eco, terms] as const))
);

export function getGenerationLicenseTerms(
  ecosystem: string | undefined
): GenerationLicenseTerms | undefined {
  return ecosystem ? termsByEcosystem.get(ecosystem) : undefined;
}

export type GenerationLicenseAcceptance = { version: number; acceptedAt: Date | string };

/** An acceptance of an older version does not count: the user agreed to different words. */
export function hasAcceptedGenerationLicense(
  acceptances: Record<string, GenerationLicenseAcceptance | undefined> | undefined,
  terms: GenerationLicenseTerms
): boolean {
  const acceptance = acceptances?.[terms.key];
  return !!acceptance && acceptance.version >= terms.version && !!acceptance.acceptedAt;
}

export const GENERATION_LICENSE_NOT_ACCEPTED = 'GENERATION_LICENSE_NOT_ACCEPTED';
