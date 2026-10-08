import type { TextScanLabel } from '~/server/services/text-scan/types';
import { NSFW_LEVEL_NAMES } from '~/server/services/text-scan/types';

const reason = { type: 'string' };
const detected = { type: 'boolean' };

function labelSchema(label: TextScanLabel): Record<string, unknown> {
  switch (label) {
    case 'nsfw':
      return {
        type: 'object',
        properties: {
          level: { type: 'string', enum: [...NSFW_LEVEL_NAMES] },
          reason: { ...reason },
        },
        required: ['level', 'reason'],
        additionalProperties: false,
      };
    case 'poi':
      return {
        type: 'object',
        properties: {
          detected: { ...detected },
          names: { type: 'array', items: { type: 'string' } },
          reason: { ...reason },
        },
        required: ['detected', 'names', 'reason'],
        additionalProperties: false,
      };
    case 'minor':
    case 'scam':
      return {
        type: 'object',
        properties: { detected: { ...detected }, reason: { ...reason } },
        required: ['detected', 'reason'],
        additionalProperties: false,
      };
  }
}

export function buildTextScanJsonSchema(labels: TextScanLabel[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: Object.fromEntries(labels.map((label) => [label, labelSchema(label)])),
    required: [...labels],
    additionalProperties: false,
  };
}

export function buildTextScanResponseFormat(labels: TextScanLabel[]) {
  return {
    type: 'json_schema' as const,
    jsonSchema: { name: 'text_scan', schema: buildTextScanJsonSchema(labels), strict: true },
  };
}
