import type { GoldPolicy } from './builder';
import type { KnownAnswerControl } from './controls';
import { supportTopicNode } from './nodes/support-topic';
import type {
  DataClass,
  DecisionQuestion,
  DecisionState,
  FormatSpec,
  GoldRow,
  ImageInput,
  ImageRef,
  Split,
} from './types';

export type SourceRow<Raw> = {
  itemId: string;
  groupKey: string;
  ts: string;
  raw: Raw;
  /** An explicit split assignment; without one the builder splits by time. */
  split?: Split;
};

export type NodeContext = { dataDir: string };

/**
 * One decision node. Domain seats add a file under `nodes/` and register it in
 * `NODES`; the harness owns splits, routing, controls and scoring.
 */
export type NodeSpec<Raw = unknown> = {
  id: string;
  specVersion: number;
  dataClass: DataClass;
  /** Action labels the scorer reports on. Gold must use these. */
  classes: readonly string[];
  formats: Record<string, FormatSpec>;
  /** Per-class Wilson lower-bound targets; a class not listed takes `score --target`. */
  targets?: Readonly<Record<string, number>>;
  /** The redaction point: return only the fields the questions need. */
  buildState(raw: Raw): DecisionState;
  imageRefs?(raw: Raw): ImageRef[];
  slices?(raw: Raw): Record<string, string>;
  /** Named incumbent predictions per item (an existing classifier, a keyword rule). */
  baselines?(raw: Raw): Record<string, string | null>;
  /**
   * A reason to keep the item out of every split, or null. Required for
   * moderation images: CSAM-reported items never enter an eval set.
   */
  exclude?(raw: Raw): string | null;
  /**
   * Every item id excluded right now (CSAM-reported, say), queried independently
   * of the sampling window: a rolling source never re-yields an old row, so
   * `exclude()` alone cannot catch a report that lands after sampling. Re-read on
   * every build and run. Required for moderation images.
   */
  excludedIds?(ctx: NodeContext): AsyncIterable<string>;
  source(ctx: NodeContext): AsyncIterable<SourceRow<Raw>>;
  gold(ctx: NodeContext): AsyncIterable<GoldRow>;
  /** Defaults to majority vote. Read from ctx so a labeller id can stay in the data dir. */
  goldPolicy?(ctx: NodeContext): GoldPolicy;
  /** Overrides the built-in known-answer control, e.g. with a node-shaped question. */
  control?: KnownAnswerControl & { image?: ImageInput };
};

export const NODES: Record<string, NodeSpec<never>> = {};

/** NodeSpec is covariant in Raw through source(), so the registry erases it once, here. */
export function registerNode<Raw>(node: NodeSpec<Raw>): void {
  if (NODES[node.id]) throw new Error(`node "${node.id}" is already registered`);
  NODES[node.id] = node as unknown as NodeSpec<never>;
}

export function getNode(id: string): NodeSpec<never> {
  const node = NODES[id];
  if (!node) {
    throw new Error(`unknown node "${id}"; registered: ${Object.keys(NODES).join(', ') || 'none'}`);
  }
  return node;
}

function isQuestion(value: unknown): value is DecisionQuestion {
  if (!value || typeof value !== 'object') return false;
  const q = value as Record<string, unknown>;
  if (typeof q.id !== 'string' || typeof q.instructions !== 'string') return false;
  if (q.type === 'noul') return true;
  if (q.type === 'score') {
    return Array.isArray(q.criteria) && q.criteria.every((c) => typeof c === 'string');
  }
  if (q.type === 'choice') {
    return (
      Array.isArray(q.options) &&
      q.options.every(
        (o) =>
          o &&
          typeof o === 'object' &&
          typeof (o as Record<string, unknown>).key === 'string' &&
          typeof (o as Record<string, unknown>).description === 'string'
      )
    );
  }
  return false;
}

/** Questions held privately under --data-dir are validated here, then hashed like any other. */
export function parseQuestionsFile(json: unknown, path: string): DecisionQuestion[] {
  if (!Array.isArray(json) || json.length === 0 || !json.every(isQuestion)) {
    throw new Error(`${path} is not a non-empty array of decision questions`);
  }
  return json;
}

registerNode(supportTopicNode);
