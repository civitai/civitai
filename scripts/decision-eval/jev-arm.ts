import { AI_MODELS } from '~/server/services/ai/openrouter';
import { askJev, type JevQuestionSpec, type JevResponse } from '~/server/services/ai/jev';
import type {
  DecisionQuestion,
  DecisionResult,
  NormalizedAnswer,
  TextDecisionModel,
  TextDecisionRequest,
} from './types';

export function toJevQuestions(questions: readonly DecisionQuestion[]): JevQuestionSpec[] {
  return questions.map((q): JevQuestionSpec => {
    if (q.type === 'choice') {
      return {
        id: q.id,
        type: 'choice',
        prompt: q.instructions,
        options: q.options.map((o) => o.key),
        optionDescriptions: Object.fromEntries(q.options.map((o) => [o.key, o.description])),
      };
    }
    if (q.type === 'score') {
      // Index space, so both arms report the same rubric position.
      return {
        id: q.id,
        type: 'score',
        prompt: q.instructions,
        min: 0,
        max: q.criteria.length - 1,
        criteria: q.criteria,
      };
    }
    return { id: q.id, type: 'noul', prompt: q.instructions };
  });
}

export function normalizeJevAnswers(response: JevResponse): NormalizedAnswer[] {
  return response.answers.map((a): NormalizedAnswer => {
    if (a.type === 'choice') {
      return {
        id: a.id,
        type: 'choice',
        value: a.value,
        probabilities: a.distribution,
        confidence: a.confidence ?? null,
        unknown: null,
        abstained: null,
      };
    }
    if (a.type === 'noul') {
      return {
        id: a.id,
        type: 'noul',
        value: a.value,
        probabilities: { yes: a.value, no: 1 - a.value },
        confidence: null,
        unknown: null,
        abstained: null,
      };
    }
    return {
      id: a.id,
      type: 'score',
      value: a.value,
      probabilities: null,
      confidence: a.confidence ?? null,
      unknown: null,
      abstained: null,
    };
  });
}

/** Hosted Jev through the production client and its pin, always with zero data retention. */
export class JevArm implements TextDecisionModel {
  readonly hosting = 'third-party' as const;
  readonly zeroDataRetention = true;
  readonly configId = `jev:${AI_MODELS.JEV}:zdr`;

  constructor(private readonly opts: { timeoutMs?: number; ask?: typeof askJev } = {}) {}

  async decide(request: TextDecisionRequest): Promise<DecisionResult> {
    const ask = this.opts.ask ?? askJev;
    const started = performance.now();
    const response = await ask(
      { state: request.state, questions: toJevQuestions(request.questions) },
      { timeoutMs: this.opts.timeoutMs ?? 10_000, zeroDataRetention: this.zeroDataRetention }
    );
    return {
      answers: normalizeJevAnswers(response),
      build: response.model,
      latencyMs: performance.now() - started,
    };
  }
}
