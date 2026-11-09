import { env } from '~/env/client';
import {
  FEEDBACK_BUILD_MAX_LENGTH,
  FEEDBACK_DEVICE_TEXT_MAX_LENGTH,
  FEEDBACK_PATH_MAX_LENGTH,
} from '~/shared/constants/feedback.constants';

export type FeedbackDevice = {
  viewport: { width: number; height: number };
  screen: { width: number; height: number };
  pixelRatio: number;
  touch: boolean;
  colorScheme: 'dark' | 'light';
  language?: string;
  timeZone?: string;
  online?: boolean;
};

export type FeedbackClientContext = {
  /** The Next.js route pattern, e.g. `/models/[id]/[[...slug]]`. The values are in `path`. */
  route?: string;
  build?: string;
  device?: FeedbackDevice;
  clientAt: string;
};

const text = (value: unknown) =>
  typeof value === 'string' && value ? value.slice(0, FEEDBACK_DEVICE_TEXT_MAX_LENGTH) : undefined;
const size = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;

/** `<package version>+<short git hash>`, the pair that names a deploy. */
export function feedbackBuildId(): string | undefined {
  const version = process.env.version;
  const hash = env.NEXT_PUBLIC_GIT_HASH?.slice(0, 7);
  const build = [version, hash].filter(Boolean).join('+');
  return build ? build.slice(0, FEEDBACK_BUILD_MAX_LENGTH) : undefined;
}

function readDevice(): FeedbackDevice | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    let timeZone: string | undefined;
    try {
      timeZone = text(Intl.DateTimeFormat().resolvedOptions().timeZone);
    } catch {
      // Intl unavailable.
    }
    const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
    return {
      viewport: { width: size(window.innerWidth), height: size(window.innerHeight) },
      screen: { width: size(window.screen?.width), height: size(window.screen?.height) },
      pixelRatio: Math.min(10, Math.round((window.devicePixelRatio || 1) * 100) / 100),
      touch: (navigator.maxTouchPoints ?? 0) > 0,
      colorScheme: dark ? 'dark' : 'light',
      language: text(navigator.language),
      timeZone,
      online: typeof navigator.onLine === 'boolean' ? navigator.onLine : undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * The reporter's environment, read when they press Send. No identifiers, no storage, no query
 * strings: the route is the pattern, not the URL. Browser and OS are read on the server from the
 * request's user agent instead, so they cannot be claimed here.
 */
export function collectClientContext({ route }: { route?: string } = {}): FeedbackClientContext {
  const build = feedbackBuildId();
  const device = readDevice();
  return {
    ...(route ? { route: route.slice(0, FEEDBACK_PATH_MAX_LENGTH) } : {}),
    ...(build ? { build } : {}),
    ...(device ? { device } : {}),
    clientAt: new Date().toISOString(),
  };
}
