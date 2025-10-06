import type { ErrorInfo, ReactNode } from 'react';
import React, { Component } from 'react';
import { ResetGenerationPanel } from '~/components/Generation/Error/ResetGenerationPanel';

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

  resetErrorBoundary() {
    this.setState({ hasError: false });
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
      <ResetGenerationPanel
        onResetClick={() => {
          this.resetErrorBoundary();
        }}
      />
    );
  }
}

export default GenerationErrorBoundary;
