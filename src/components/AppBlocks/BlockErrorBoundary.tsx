import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { BlockFallback } from './BlockFallback';

interface Props {
  blockName?: string;
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

/**
 * Containment around a single BlockHost. The host throws explicitly for the
 * v1 InlineHost stub, and any unhandled exception thrown anywhere inside the
 * block tree would otherwise bubble up and crash the entire model page.
 * Render isolation matters more than diagnostic depth here — log to console
 * for triage, render a benign fallback.
 */
export class BlockErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error('[AppBlocks] block crashed', { error, info });
  }

  render() {
    if (this.state.hasError) {
      return <BlockFallback reason="fatal_block_error" blockName={this.props.blockName} />;
    }
    return this.props.children;
  }
}
