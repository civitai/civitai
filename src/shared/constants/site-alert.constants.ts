import type { DomainColor } from '~/shared/utils/prisma/enums';

export const siteAlertSeverities = ['info', 'warning', 'outage', 'resolved'] as const;
export type SiteAlertSeverity = (typeof siteAlertSeverities)[number];

// Only 'everywhere' renders in v1; 'generator' and 'trainer' are stored for a later surface.
export const siteAlertSurfaces = ['everywhere', 'generator', 'trainer'] as const;
export type SiteAlertSurface = (typeof siteAlertSurfaces)[number];

export const SITE_ALERT_DEFAULT_DURATION_MS = 2 * 60 * 60 * 1000;
export const SITE_ALERT_MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
export const SITE_ALERTS_VERSION_HEADER = 'x-alerts-version';
// Field of the CLIENT sysRedis hash, so the read that already serves needsUpdate carries it.
export const SITE_ALERTS_VERSION_FIELD = 'siteAlertsVersion';

export type SiteAlert = {
  id: number;
  severity: SiteAlertSeverity;
  title: string;
  message: string | null;
  paths: string[];
  surfaces: SiteAlertSurface[];
  domains: DomainColor[];
  startsAt: string;
  endsAt: string;
  dismissible: boolean;
};

export type SiteAlertActor = { id: number; username: string; at: string };

export type SiteAlertRecord = SiteAlert & {
  createdBy: SiteAlertActor;
  updatedBy: SiteAlertActor;
};

export type SiteAlertsPayload = { version: number; alerts: SiteAlert[] };

// Page routes only: the generator and trainer panels open on any page and are not covered here.
export const siteAlertPresets: { label: string; paths: string[] }[] = [
  {
    label: 'Model publishing',
    paths: ['/models/create', '/models/*/wizard', '/models/*/edit', '/models/*/model-versions/**'],
  },
  {
    label: 'Model upload',
    paths: ['/models/create', '/models/*/wizard', '/models/*/model-versions/**'],
  },
  { label: 'Image posting', paths: ['/posts/create', '/posts/batch', '/posts/*/edit'] },
  { label: 'Generator', paths: ['/generate'] },
  { label: 'Training', paths: ['/train', '/models/train', '/models/train/**', '/training/**'] },
  { label: 'Buzz purchase', paths: ['/purchase/buzz', '/pricing', '/pricing/buzz'] },
  { label: 'Search', paths: ['/search/**'] },
  { label: 'Articles', paths: ['/articles/create', '/articles/*/edit'] },
  { label: 'Sign-in', paths: ['/login', '/login/**'] },
];

export const SITE_ALERT_BROKEN_TEMPLATE = (feature: string) => ({
  severity: 'outage' as const,
  title: `${feature} is broken`,
  message: 'We know about it and a fix is rolling out. Thanks for your patience.',
});
