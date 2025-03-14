import { logToAxiom } from '~/server/logging/client';
import { ModerationRuleAction, TagSource } from '~/shared/utils/prisma/enums';

export type AndRule = {
  type: 'and';
  rules: RuleDefinition[];
};

export type OrRule = {
  type: 'or';
  rules: RuleDefinition[];
};

export type ContentRule = {
  type: 'content';
  target: ('prompt' | 'title' | 'description')[];
  match: string;
};

export type TagRule = {
  type: 'tag';
  tags: string[];
  match: 'all' | 'any';
  sources: TagSource[];
};

export type PropertyRule = {
  type: 'property';
  condition: string;
};

export type RuleDefinition = AndRule | OrRule | ContentRule | TagRule | PropertyRule;
type ModRule = { definition: RuleDefinition; action: ModerationRuleAction };

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
        rule.match.slice(1, rule.match.lastIndexOf('/')),
        rule.match.slice(rule.match.lastIndexOf('/') + 1)
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
