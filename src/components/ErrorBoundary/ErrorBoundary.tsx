import React, { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
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
    console.log({ error, errorInfo });
  }
  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="w-full h-full flex justify-center items-center">
        <div className="flex flex-col gap-3">
          <h2>Application error!</h2>
          {/* <p>{this.state.error?.message}</p>
          <button type="button" onClick={() => this.setState({ hasError: false })}>
            Try again?
          </button> */}
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
