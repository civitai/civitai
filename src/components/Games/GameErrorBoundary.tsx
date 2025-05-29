import { Text, Title } from '@mantine/core';
import type { ErrorInfo } from 'react';
import React, { Component } from 'react';

type Props = { children: React.ReactNode };
type State = { hasError: boolean; error?: Error; stack?: string };

export default class GameErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.log('Error Boundary:', { error, errorInfo });
    this.setState({ error, stack: errorInfo.componentStack, hasError: true });
    fetch('/api/application-error', {
      method: 'POST',
      body: JSON.stringify({ message: error.message, stack: errorInfo.componentStack }),
    });
  }

  // TODO.newOrder: update error boundary to show a different message
  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="flex size-full flex-col items-center justify-center p-2">
        <div className="mb-5 flex flex-col items-center">
          <Title>Whoops!</Title>
          <Title>{`Something went wrong :(`}</Title>
        </div>
        <Text>Try refreshing or navigating to a different page</Text>
      </div>
    );
  }
}
