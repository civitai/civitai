import { join } from 'path';

import { EVAL_INDEX_FILE, EXCLUSIONS_FILE } from './builder';

export function nodePaths(dataDir: string, nodeId: string) {
  const root = join(dataDir, nodeId);
  return {
    root,
    manifest: join(root, 'manifest.jsonl'),
    gold: join(root, 'gold.jsonl'),
    evalIndex: join(root, EVAL_INDEX_FILE),
    exclusions: join(root, EXCLUSIONS_FILE),
    controls: join(root, 'controls.jsonl'),
    sealed: join(root, 'sealed-test.json'),
    predictions: (key: string) => join(root, 'runs', key, 'predictions.jsonl'),
    report: (key: string, split: string) => join(root, 'runs', key, `report-${split}.md`),
    thresholds: (key: string, split: string) => join(root, 'runs', key, `thresholds-${split}.json`),
    weighted: (key: string, split: string, period?: string) =>
      join(root, 'runs', key, `weighted-${split}${period ? `-${period}` : ''}.json`),
  };
}
