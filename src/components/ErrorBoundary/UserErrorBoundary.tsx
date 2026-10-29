import { Anchor, Divider, Text, Title } from '@mantine/core';
import type { ErrorInfo, ReactNode } from 'react';
import React, { Component, Fragment } from 'react';
import { navRegistry } from '~/components/HomeContentToggle/nav-registry';
import { resolveNavItems } from '~/components/HomeContentToggle/resolve-nav-items';
import { NextLink } from '~/components/NextLink/NextLink';
import { reportBoundaryError } from '~/components/ErrorBoundary/reportBoundaryError';
import type { FeatureAccess } from '~/server/services/feature-flags.service';

interface Props {
  children: ReactNode;
  features: FeatureAccess;
  /**
   * The fallback clears when this changes. Only on a change, so a page that
   * throws again on the new route shows the fallback once rather than looping.
   */
  resetKey?: string;
}

interface State {
  hasError: boolean;
  resetKey?: string;
  error?: Error;
  stack?: string;
}

class UserErrorBoundary extends Component<Props, State> {
  state: State = {
    hasError: false,
    resetKey: this.props.resetKey,
  };

  // Defaults, not the viewer's saved layout: this renders after something already threw, and a
  // class component cannot reach the settings hook. `isAuthed: false` costs nothing — every
  // signed-in-only destination is `hidden` by default, so it would not be listed either way.
  options = (() => {
    const { bar, more } = resolveNavItems(navRegistry, {
      features: this.props.features,
      isAuthed: false,
    });
    return [...bar, ...more];
  })();

  // In render rather than componentDidUpdate, so the new route renders in the
  // same pass instead of committing the old fallback first and resetting after.
  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey === state.resetKey) return null;
    return { resetKey: props.resetKey, hasError: false, error: undefined, stack: undefined };
  }

  static getDerivedStateFromError(error: Error) {
    // Update state so the next render will show the fallback UI
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.log('Error Boundary:', { error, errorInfo });
    this.setState({ error, stack: errorInfo.componentStack });
    // Reports to Faro AND to /api/application-error. The second sink is the pre-existing one and
    // its server-side log alerting already watched it; what this adds is the Faro half, which no
    // error boundary reached before.
    reportBoundaryError(error, { boundary: 'user', componentStack: errorInfo.componentStack });
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className="flex size-full flex-col items-center justify-center p-2">
        <div className="mb-5 flex flex-col items-center">
          <Title>Whoops!</Title>
          <Title>{`Something went wrong :(`}</Title>
        </div>
        <Text>Try refreshing or navigating to a different page</Text>
        <ul className="mt-1 flex flex-wrap gap-2">
          {this.options.map(({ key, url }, i) => (
            <Fragment key={key}>
              {/* A client navigation to the page already showing changes no key,
                  so that one link reloads instead. */}
              {typeof window !== 'undefined' && url === window.location.pathname ? (
                <Anchor component="a" href={url} className="capitalize leading-none">
                  {key}
                </Anchor>
              ) : (
                <Anchor component={NextLink} href={url} className="capitalize leading-none">
                  {key}
                </Anchor>
              )}
              {i !== this.options.length - 1 && <Divider orientation="vertical" />}
            </Fragment>
          ))}
        </ul>
      </div>
    );
  }
}

export default UserErrorBoundary;
