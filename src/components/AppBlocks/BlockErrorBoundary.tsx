import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { BlockFallback } from './BlockFallback';
import { sendBlockRender } from './sendBlockRender';

interface Props {
  blockName?: string;
  // Identifiers for the render-FAILURE beacon fired on a host-tree crash. When
  // present, a caught error emits `civitai_app_block_renders_total{result=error}`
  // (via the /api/track/block-render beacon). Optional so the boundary still
  // works as pure render isolation where the ids aren't threaded.
  appBlockId?: string;
  blockInstanceId?: string;
  slotId?: string;
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
  // Emit-once guard so a crash that re-renders can't double-fire the beacon.
  private beaconFired = false;

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error('[AppBlocks] block crashed', { error, info });

    // Runtime observability: a host-tree crash is a genuine render failure —
    // fire the `error` render beacon once. Only when we have the identifiers to
    // attribute it (the v1 InlineHost-stub throw path has none, so it's skipped).
    const { appBlockId, blockInstanceId, slotId } = this.props;
    if (!this.beaconFired && appBlockId && blockInstanceId && slotId) {
      this.beaconFired = true;
      sendBlockRender({
        appBlockId,
        blockInstanceId,
        slotId,
        status: 'error',
        errorClass: 'error_boundary',
      });
    }
  }

  render() {
    if (this.state.hasError) {
      return <BlockFallback reason="fatal_block_error" blockName={this.props.blockName} />;
    }
    return this.props.children;
  }
}
