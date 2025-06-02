import { Title, Text } from '@mantine/core';
import type { ErrorInfo, ReactNode } from 'react';
import React, { Component } from 'react';
import { TwCard } from '~/components/TwCard/TwCard';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
  stack?: string;
}

class GenerationErrorBoundary extends Component<Props, State> {
  state: State = {
    hasError: false,
  };

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
      body: JSON.stringify({
        message: error.message,
        stack: errorInfo.componentStack,
        name: 'generation-error',
      }),
    });
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className="flex size-full flex-col items-center justify-center p-2">
        <div className="mb-5 flex flex-col items-center">
          <div className="overflow-hidden rounded-xl shadow">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/images/media/whoops.jpg"
              alt="something went wrong"
              className="w-full max-w-[200px]"
            />
          </div>
          <br />
          <Title order={3}>{`Something went wrong :(`}</Title>
          <Text>Try refreshing your browser</Text>
        </div>
      </div>
    );
  }
}

export default GenerationErrorBoundary;
