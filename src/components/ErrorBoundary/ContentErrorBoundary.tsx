import type { ErrorInfo, ReactNode } from 'react';
import { Component, Fragment } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  errorCount: number;
}

class ContentErrorBoundary extends Component<Props, State> {
  state: State = {
    errorCount: 0,
  };

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState((state) => ({ errorCount: state.errorCount + 1 }));
  }

  render() {
    return <Fragment key={this.state.errorCount}>{this.props.children}</Fragment>;
  }
}

export default ContentErrorBoundary;
