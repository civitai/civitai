import { createHash } from 'node:crypto';
import { composeUserMessage } from '../../text-scan-lab/compose';
import type { LabField } from '../../text-scan-lab/types';

// Relative imports only: `text-scan-lab/import.ts` loads this under plain tsx. Server-only (node:crypto),
// so it stays out of `$lib/text-scan-lab/compose`, which pages import.

// Comparable with production's.
export const hashLabText = (fields: LabField[]) =>
  createHash('sha256').update(composeUserMessage(fields)).digest('hex');
