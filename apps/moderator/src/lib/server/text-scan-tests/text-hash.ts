import { createHash } from 'node:crypto';
import type { LabField } from '../../text-scan-lab/types';

export const hashLabFields = (fields: readonly LabField[]) =>
  createHash('sha256')
    .update(JSON.stringify(fields.map((field) => [field.heading, field.text])))
    .digest('hex');
