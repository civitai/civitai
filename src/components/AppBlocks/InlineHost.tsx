import type { BlockInstall, SlotContext } from './types';

interface InlineHostProps {
  install: BlockInstall;
  context: SlotContext;
  token: string;
}

/**
 * Inline (in-page) host. v1 STUB — not active in production.
 *
 * Establishes the file and interface contract for v2. In v1 the dispatcher
 * in BlockHost never routes here (`canUseInline` is always false for the
 * unverified trust tier and we have no verified apps until Phase 5).
 */
export function InlineHost(_props: InlineHostProps) {
  if (process.env.NODE_ENV !== 'production') {
    // Dev-time guard — make it loud if v1 dispatch leaks an inline install in.
    // eslint-disable-next-line no-console
    console.error('[AppBlocks] InlineHost should not render in v1');
  }
  throw new Error(
    'InlineHost is not enabled in production. Only verified/internal trust tier apps may use inline rendering, and the inline render pipeline lands in v2 (Phase 6).'
  );
}
