import { describe, expect, it } from 'vitest';
import {
  MAX_METADATA_TOOL_COUNT,
  MAX_METADATA_TOOLS_JSON_LENGTH,
  normalizeMetadataToolNames,
  parseMetadataToolNames,
} from '../declared-tools.metadata';

describe('declared metadata tools', () => {
  it('keeps bounded, valid, unique tool names', () => {
    expect(normalizeMetadataToolNames([' Editor ', 42, '', 'editor', 'Post Processor'])).toEqual([
      'Editor',
      'Post Processor',
    ]);
  });

  it('discards malformed metadata', () => {
    expect(parseMetadataToolNames('{bad json')).toBeUndefined();
    expect(parseMetadataToolNames({ tools: ['Editor'] })).toBeUndefined();
    expect(parseMetadataToolNames(' '.repeat(MAX_METADATA_TOOLS_JSON_LENGTH + 1))).toBeUndefined();
  });

  it('caps oversized lists before tool resolution', () => {
    const names = Array.from(
      { length: MAX_METADATA_TOOL_COUNT + 20 },
      (_, index) => `Tool ${index}`
    );
    expect(normalizeMetadataToolNames(names)).toEqual(names.slice(0, MAX_METADATA_TOOL_COUNT));
  });

  it('parses the JSON array used by PNG text metadata', () => {
    expect(parseMetadataToolNames('["Editor","Post Processor"]')).toEqual([
      'Editor',
      'Post Processor',
    ]);
  });
});
