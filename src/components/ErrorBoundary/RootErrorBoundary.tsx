import type { ErrorInfo, ReactNode } from 'react';
import { Component } from 'react';
import { reportBoundaryError } from '~/components/ErrorBoundary/reportBoundaryError';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

/**
 * The OUTERMOST boundary — it wraps `_app`'s own render body, and nothing else can.
 *
 * 🔴 Why this exists, and why `UserErrorBoundary` cannot do this job: a React error boundary
 * cannot catch a throw from its own PARENT's render. Every boundary the app had lived inside
 * the JSX that `_app` returns, so a throw in `_app`'s render body itself reached no boundary,
 * no fallback, and no reporting path — React unmounts the whole tree and the user gets a blank
 * page. That is what #4867 looked like (`getSiteSchema` indexing `serverDomains` unguarded on a
 * client-side navigation): no client-side report of any kind, and nothing server-side either,
 * because a hard load still rendered fine and no boundary was ever entered.
 *
 * 🔴 Its fallback must depend on NOTHING. It renders above `ThemeProvider`, `AppProvider`,
 * `FeatureFlagsProvider` and the session, so it deliberately uses no hooks, no context, no
 * Mantine components and no theme tokens — only inline styles and a native anchor. The whole
 * point is a fallback that cannot itself throw; `UserErrorBoundary`'s fallback calls
 * `useFeatureFlags` and `resolveNavItems`, which is exactly why it is unsafe at this level and
 * stays where it is, deeper in the tree.
 */
export class RootErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    reportBoundaryError(error, { boundary: 'root', componentStack: errorInfo.componentStack });
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div
        role="alert"
        style={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          padding: 24,
          textAlign: 'center',
          fontFamily: 'system-ui, sans-serif',
          background: '#1a1b1e',
          color: '#c1c2c5',
        }}
      >
        <h1 style={{ margin: 0, fontSize: 24 }}>Something went wrong</h1>
        <p style={{ margin: 0, maxWidth: 420, lineHeight: 1.5 }}>
          This page failed to load. Reloading usually fixes it — the error has been reported.
        </p>
        {/*
          eslint-disable-next-line @next/next/no-html-link-for-pages --
          A raw <a> is REQUIRED here, not an oversight. `next/link` reaches into the Next router,
          and this fallback renders precisely when the React tree above the router has already
          failed — a client-side navigation would re-mount the same broken tree. A full document
          load is also the actual recovery for the class of bug this boundary exists to catch:
          in #4867 a hard load always worked, only in-app navigation threw.
        */}
        <a href="/" style={{ color: '#4dabf7' }}>
          Go to the homepage
        </a>
      </div>
    );
  }
}
