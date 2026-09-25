import { describe, expect, it } from 'vitest';
import {
  buildTextScanJsonSchema,
  buildTextScanResponseFormat,
} from '~/server/services/text-scan/schema';

describe('buildTextScanJsonSchema', () => {
  it('requires exactly the requested labels and forbids extras', () => {
    const schema = buildTextScanJsonSchema(['nsfw', 'poi']) as {
      required: string[];
      additionalProperties: boolean;
      properties: Record<string, unknown>;
    };
    expect(schema.required).toEqual(['nsfw', 'poi']);
    expect(Object.keys(schema.properties)).toEqual(['nsfw', 'poi']);
    expect(schema.additionalProperties).toBe(false);
  });

  it('constrains nsfw.level to the five categorical names', () => {
    const schema = buildTextScanJsonSchema(['nsfw']) as any;
    expect(schema.properties.nsfw.properties.level.enum).toEqual(['none', 'pg13', 'r', 'x', 'xxx']);
    expect(schema.properties.nsfw.required).toEqual(['level', 'reason']);
  });

  it('gives poi a names array and every flag label a detected boolean', () => {
    const schema = buildTextScanJsonSchema(['poi', 'minor', 'scam']) as any;
    expect(schema.properties.poi.required).toEqual(['detected', 'names', 'reason']);
    expect(schema.properties.poi.properties.names).toEqual({
      type: 'array',
      items: { type: 'string' },
    });
    expect(schema.properties.minor.required).toEqual(['detected', 'reason']);
    expect(schema.properties.scam.properties.detected).toEqual({ type: 'boolean' });
  });

  it('wraps the schema as a strict json_schema response format', () => {
    const format = buildTextScanResponseFormat(['scam']);
    expect(format).toMatchObject({
      type: 'json_schema',
      jsonSchema: { name: 'text_scan', strict: true },
    });
  });

  it('does not share nested objects between calls', () => {
    const a = buildTextScanJsonSchema(['nsfw']) as any;
    a.properties.nsfw.required.push('mutated');
    const b = buildTextScanJsonSchema(['nsfw']) as any;
    expect(b.properties.nsfw.required).toEqual(['level', 'reason']);
  });
});
