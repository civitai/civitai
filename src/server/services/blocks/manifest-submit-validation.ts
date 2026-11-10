import { deriveOauthBitmaskFromBlockScopes } from '~/shared/constants/block-scope.constants';

/**
 * The deep manifest validation a submitted version must pass at SUBMIT, against the same context
 * approve validates it in, so a manifest a moderator could never approve is refused to its author
 * before it reaches the review queue. Approve still runs the validator again.
 */

/**
 * A submitted manifest the approve-time validator would refuse. `errors` is the validator's full
 * list, returned to the submitter by the submit routes.
 */
export class ManifestValidationRefusal extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(`Invalid manifest: ${errors.slice(0, 5).join('; ')}`);
    this.name = 'ManifestValidationRefusal';
    this.errors = errors;
  }
}

export function isManifestValidationRefusal(err: unknown): err is ManifestValidationRefusal {
  return err instanceof ManifestValidationRefusal;
}

/**
 * The OAuth context a version's manifest is validated against, at submit and at approve.
 *
 * The OAuth ceiling for an app-block client is the bitmask DERIVED from the manifest's declared
 * scopes (A1/A3/A4: never TokenScope.Full, which made every manifest scope trivially in-ceiling),
 * matching what approve writes to OauthClient.allowedScopes. Allowed origins are the per-app
 * subdomain approve creates the client with for a first version (`existingAllowedOrigins: null`),
 * else the live client's.
 */
export function manifestValidationContext(args: {
  slug: string;
  manifest: Record<string, unknown>;
  existingAllowedOrigins: string[] | null;
  appsDomain: string;
}): { allowedScopes: number; allowedOrigins: string[] } {
  const scopes = Array.isArray(args.manifest.scopes) ? (args.manifest.scopes as string[]) : [];
  return {
    allowedScopes: deriveOauthBitmaskFromBlockScopes(scopes),
    allowedOrigins:
      args.existingAllowedOrigins === null
        ? [`https://${args.slug}.${args.appsDomain}`]
        : args.existingAllowedOrigins.map((o) => o.toLowerCase()),
  };
}

/**
 * Throws {@link ManifestValidationRefusal} unless `manifest` passes the deep validator. Validated
 * on a copy carrying the server-owned trust tier (the existing app's, else `unverified`), so the
 * stored manifest is not changed.
 */
export async function assertManifestValidAtSubmit(args: {
  slug: string;
  manifest: Record<string, unknown>;
  trustTier: string | null;
  existingAllowedOrigins: string[] | null;
  appsDomain: string;
}): Promise<void> {
  const { BlockManifestValidator } = await import(
    '~/server/services/block-manifest-validator.service'
  );
  const validation = await BlockManifestValidator.validateSubmission(
    { ...args.manifest, trustTier: args.trustTier ?? 'unverified' },
    manifestValidationContext(args)
  );
  if (!validation.valid) throw new ManifestValidationRefusal(validation.errors);
}
