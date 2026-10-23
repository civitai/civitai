import type { SiteAlert } from '~/shared/constants/site-alert.constants';
import type { ColorDomain } from '~/shared/constants/domain.constants';

const MAX_PATTERN_SEGMENTS = 20;
const MAX_GLOBSTARS = 3;

function segments(path: string) {
  return path
    .split(/[?#]/)[0]
    .split('/')
    .filter(Boolean)
    .map((x) => x.toLowerCase());
}

/**
 * A pattern is an absolute path whose segments are literals, `*` (exactly one segment) or `**`
 * (any number of segments, including none). A wildcard inside a segment (`/mod*`) is not a glob.
 */
export function isValidAlertPathPattern(pattern: string) {
  if (!pattern.startsWith('/') || /[?#\s]/.test(pattern)) return false;
  const parts = segments(pattern);
  if (parts.length > MAX_PATTERN_SEGMENTS) return false;
  if (parts.filter((x) => x === '**').length > MAX_GLOBSTARS) return false;
  return parts.every((x) => x === '*' || x === '**' || !x.includes('*'));
}

function matchFrom(pattern: string[], path: string[], i: number, j: number): boolean {
  if (i === pattern.length) return j === path.length;
  if (pattern[i] === '**') {
    for (let k = j; k <= path.length; k++) if (matchFrom(pattern, path, i + 1, k)) return true;
    return false;
  }
  if (j === path.length) return false;
  if (pattern[i] !== '*' && pattern[i] !== path[j]) return false;
  return matchFrom(pattern, path, i + 1, j + 1);
}

export function matchAlertPath(pattern: string, pathname: string) {
  return matchFrom(segments(pattern), segments(pathname), 0, 0);
}

/** No patterns means every path. */
export function matchesAnyAlertPath(patterns: string[], pathname: string) {
  return patterns.length === 0 || patterns.some((p) => matchAlertPath(p, pathname));
}

export function isSiteAlertVisible(
  alert: SiteAlert,
  { pathname, domain, now }: { pathname: string; domain: ColorDomain; now: number }
) {
  return (
    alert.surfaces.includes('everywhere') &&
    (alert.domains.includes('all') || alert.domains.includes(domain)) &&
    new Date(alert.startsAt).getTime() <= now &&
    new Date(alert.endsAt).getTime() > now &&
    matchesAnyAlertPath(alert.paths, pathname)
  );
}

const severityOrder = { outage: 0, warning: 1, info: 2, resolved: 3 } as const;

export function visibleSiteAlerts(
  alerts: SiteAlert[],
  ctx: { pathname: string; domain: ColorDomain; now: number }
) {
  return alerts
    .filter((x) => isSiteAlertVisible(x, ctx))
    .sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity] || b.id - a.id);
}
