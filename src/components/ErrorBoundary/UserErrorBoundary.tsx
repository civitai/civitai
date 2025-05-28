import { Anchor, Divider, Text, Title } from '@mantine/core';
import type { ErrorInfo, ReactNode } from 'react';
import React, { Component, Fragment } from 'react';
import { filterHomeOptions } from '~/components/HomeContentToggle/HomeContentToggle';
import { NextLink } from '~/components/NextLink/NextLink';
import type { FeatureAccess } from '~/server/services/feature-flags.service';

interface Props {
  children: ReactNode;
  features: FeatureAccess;
}

interface State {
  hasError: boolean;
  error?: Error;
  stack?: string;
}

class UserErrorBoundary extends Component<Props, State> {
  state: State = {
    hasError: false,
  };

  options = filterHomeOptions(this.props.features);

  static getDerivedStateFromError(error: Error) {
    // Update state so the next render will show the fallback UI
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // You can use your own error logging service here
    console.log('Error Boundary:', { error, errorInfo });
    this.setState({ error, stack: errorInfo.componentStack });
    fetch('/api/application-error', {
      method: 'POST',
      body: JSON.stringify({ message: error.message, stack: errorInfo.componentStack }),
    });
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
              <Anchor component="a" href={url} className="capitalize leading-none">
                {key}
              </Anchor>
              {i !== this.options.length - 1 && <Divider orientation="vertical" />}
            </Fragment>
          ))}
        </ul>
      </div>
    );
  }
}

export default UserErrorBoundary;
