import { describe, expect, it } from 'vitest';
import { isSemanticDefinition, semanticModelRuleSchema } from './model-rules';

describe('semanticModelRuleSchema', () => {
  it('parses a minimal definition with defaults', () => {
    expect(semanticModelRuleSchema.parse({ type: 'semantic', subject: ' Jane Doe ' })).toEqual({
      type: 'semantic',
      subject: 'Jane Doe',
      description: '',
      aliases: [],
    });
  });

  it('rejects empty-string aliases', () => {
    expect(
      semanticModelRuleSchema.safeParse({ type: 'semantic', subject: 'Jane', aliases: [' '] })
        .success
    ).toBe(false);
  });
});

describe('isSemanticDefinition', () => {
  it('accepts a semantic definition and rejects a regex one', () => {
    expect(isSemanticDefinition({ type: 'semantic', subject: 'x' })).toBe(true);
    expect(isSemanticDefinition({ type: 'content', match: '/x/' })).toBe(false);
    expect(isSemanticDefinition(null)).toBe(false);
  });
});
