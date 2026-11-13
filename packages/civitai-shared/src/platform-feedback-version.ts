import semver from 'semver';

/**
 * An `apps-platform` client or fix version, normalised to full semver, or `null` when it does not
 * parse. The main app's platform-feedback service compares a reporter's client version against a
 * resolution's `fixedIn.version` with this, and the moderator app refuses a `fixedIn.version` it
 * returns `null` for — so a version a moderator can store is always one the regression check reads.
 *
 * Short forms (`2`, `1.4`) are padded because `semver.valid` only accepts three parts.
 */
export function parsePlatformFeedbackVersion(version: string): string | null {
  const padded = /^v?\d+(\.\d+)?$/.test(version)
    ? `${version}${version.includes('.') ? '.0' : '.0.0'}`
    : version;
  return semver.valid(padded);
}
