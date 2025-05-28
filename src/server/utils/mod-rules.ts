import { logToAxiom } from '~/server/logging/client';
import type { ModerationRuleAction, TagSource } from '~/shared/utils/prisma/enums';

/**
 * Moderation rules are used to automatically moderate content based on certain conditions.
 * The rules are evaluated in order, and the first rule that matches will be applied.
 *
 * @example
 * const rule: RuleDefinition[] = {
 *   type: 'and',
 *   rules: [
 *     {
 *       type: 'content',
 *       target: ['prompt'],
 *       match: '/\\b(?:nsfw|18\\+|adult)\\b/gmi',
 *     },
 *     {
 *       type: 'tag',
 *       tags: ['nsfw'],
 *       match: 'any',
 *     },
 *     {
 *      type: 'property',
 *      condition: '$.modelVersion.baseModel === 'LTX',
 *     },
 *   ],
 * };
 */

export type ContentRule = {
  type: 'content';
  target: ('prompt' | 'name' | 'description')[];
  match: string; // Can be a regex (i.e.: /robot/gmi) or a simple string
};

export type TagRule = {
  type: 'tag';
  tags: string[];
  match: 'all' | 'any';
  sources?: TagSource[];
};

export type PropertyRule = {
  type: 'property';
  condition: string; // i.e.: $.metadata.width > 400
};

export type AndRule = {
  type: 'and';
  rules: RuleDefinition[];
};

export type OrRule = {
  type: 'or';
  rules: RuleDefinition[];
};

export type RuleDefinition = AndRule | OrRule | ContentRule | TagRule | PropertyRule;
type ModRule = {
  id: number;
  definition: RuleDefinition;
  action: ModerationRuleAction;
  reason?: string | null;
};

export function evaluateRules(rules: ModRule[], obj: any) {
  for (const rule of rules) {
    const result = evaluateRule(rule.definition, obj);
    if (result) return rule;
  }
}

export function evaluateRule(rule: RuleDefinition, obj: any): boolean {
  switch (rule.type) {
    case 'and':
      return rule.rules.every((subRule) => evaluateRule(subRule, obj));
    case 'or':
      return rule.rules.some((subRule) => evaluateRule(subRule, obj));
    case 'content':
      const regex = new RegExp(
        rule.match.startsWith('/') ? rule.match.slice(1, rule.match.lastIndexOf('/')) : rule.match,
        rule.match.endsWith('/') ? rule.match.slice(rule.match.lastIndexOf('/') + 1) : 'gmi'
      );

      return rule.target.some((target) => {
        const value: string = obj[target];
        return regex.test(value);
      });
    case 'tag':
      const tags = obj.tags || [];

      if (rule.match === 'all') return rule.tags.every((tag) => tags.includes(tag));
      else return rule.tags.some((tag) => tags.includes(tag));
    case 'property':
      return evaluateCondition(rule.condition, obj);
    default:
      return false;
  }
}

function evaluateCondition(condition: string, obj: any): boolean {
  try {
    const func = new Function('$', `return ${condition}`);
    return func(obj);
  } catch (error) {
    logToAxiom({
      name: 'moderation-rule',
      type: 'error',
      message: 'Error evaluating condition',
      error,
    });
    return false;
  }
}
