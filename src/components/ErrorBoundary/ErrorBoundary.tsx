import { Alert, Button } from '@mantine/core';
import React, { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
  errorInfo?: ErrorInfo;
}

class ErrorBoundary extends Component<Props, State> {
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
    this.setState({ error, errorInfo });
  }
  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="size-full overflow-auto">
        <div className="container  py-3">
          <div className="flex flex-col gap-3">
            <Alert color="red" title="Application Error!">
              {this.state.error && <pre>{JSON.stringify(this.state.error, null, 2)}</pre>}
              <div className="flex gap-2">
                <Button className="mt-1" type="button" onClick={() => history.back()}>
                  Previous page
                </Button>
                <Button
                  className="mt-1"
                  type="button"
                  onClick={() => {
                    location.href = location.href;
                  }}
                >
                  Reload page
                </Button>
                <Button
                  className="mt-1"
                  type="button"
                  onClick={() => {
                    location.href = '/';
                  }}
                >
                  Home
                </Button>
              </div>
            </Alert>
            {this.state.errorInfo && (
              <Alert color="yellow">
                <pre>{this.state.errorInfo?.componentStack}</pre>
              </Alert>
            )}
          </div>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
