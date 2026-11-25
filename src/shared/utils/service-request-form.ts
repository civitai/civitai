import * as z from 'zod';
import {
  SERVICE_DELIVERY_DAYS_MAX,
  SERVICE_PRICE_MAX,
  SERVICE_PRICE_MIN,
} from '~/shared/constants/creator-service.constants';

export const SERVICE_FORM_QUESTIONS_MAX = 8;
export const SERVICE_FORM_OPTIONS_MAX = 10;
export const SERVICE_FORM_LABEL_MAX = 120;
export const SERVICE_FORM_ANSWER_MAX = 2_000;
/** The most a number question may ask for. */
export const SERVICE_FORM_QUANTITY_MAX = 100;

const id = z.string().trim().min(1).max(24);
/** Shown publicly beside the title, so plain text only: no markup, no links. */
const label = z
  .string()
  .trim()
  .min(1)
  .max(SERVICE_FORM_LABEL_MAX)
  .refine((text) => !/[<>]|:\/\/|www\./i.test(text), {
    message: 'Use plain text, without links or markup',
  });
const buzz = z.number().int().min(0).max(SERVICE_PRICE_MAX);
const days = z.number().int().min(0).max(SERVICE_DELIVERY_DAYS_MAX);

const optionSchema = z.object({ id, label, price: buzz, days });
const options = (min: number) =>
  z
    .array(optionSchema)
    .min(min)
    .max(SERVICE_FORM_OPTIONS_MAX)
    .refine((list) => new Set(list.map((option) => option.id)).size === list.length, {
      message: 'Each option needs its own id',
    });

const questionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('pickOne'), id, label, options: options(2) }),
  z.object({ type: z.literal('pickAny'), id, label, options: options(1) }),
  z
    .object({
      type: z.literal('number'),
      id,
      label,
      min: z.number().int().min(0).max(SERVICE_FORM_QUANTITY_MAX),
      max: z.number().int().min(1).max(SERVICE_FORM_QUANTITY_MAX),
      /** How many the base price covers; each one past it adds `price` and `days`. */
      included: z.number().int().min(0).max(SERVICE_FORM_QUANTITY_MAX),
      price: buzz,
      days,
    })
    .refine((question) => question.min <= question.max, {
      message: 'The smallest number must not be above the largest',
    }),
  z.object({ type: z.literal('text'), id, label, required: z.boolean() }),
]);

export type ServiceRequestForm = z.infer<typeof serviceRequestFormSchema>;
export type ServiceFormQuestion = ServiceRequestForm['questions'][number];
export const serviceRequestFormSchema = z.object({
  questions: z
    .array(questionSchema)
    .min(1)
    .max(SERVICE_FORM_QUESTIONS_MAX)
    .refine((list) => new Set(list.map((question) => question.id)).size === list.length, {
      message: 'Each question needs its own id',
    }),
});

export type ServiceFormAnswers = z.infer<typeof serviceFormAnswersSchema>;
export const serviceFormAnswersSchema = z.record(
  id,
  z.union([
    z.string().max(SERVICE_FORM_ANSWER_MAX),
    z.array(id).max(SERVICE_FORM_OPTIONS_MAX),
    z.number().int(),
  ])
);

/** One line of what the buyer pays: the base, then each answer that adds Buzz or days. */
export type ServicePriceLine = { label: string; price: number; days: number };
/** What the buyer answered, by question, as the deal shows it. */
export type ServiceFormAnswerLine = { label: string; answer: string };

type Base = { price: number; deliveryDays: number };

const priceLine = ({ label, price, days }: ServicePriceLine): ServicePriceLine => ({
  label,
  price,
  days,
});

const extras = (question: Extract<ServiceFormQuestion, { type: 'number' }>, count: number) =>
  Math.max(0, count - question.included);

/** The cheapest and dearest totals, and the most days, any valid answers give. */
export function serviceFormRange(form: ServiceRequestForm, base: Base) {
  let minPrice = base.price;
  let maxPrice = base.price;
  let minDays = base.deliveryDays;
  let maxDays = base.deliveryDays;
  for (const question of form.questions) {
    if (question.type === 'pickOne') {
      minPrice += Math.min(...question.options.map((option) => option.price));
      maxPrice += Math.max(...question.options.map((option) => option.price));
      minDays += Math.min(...question.options.map((option) => option.days));
      maxDays += Math.max(...question.options.map((option) => option.days));
    } else if (question.type === 'pickAny') {
      for (const option of question.options) {
        maxPrice += option.price;
        maxDays += option.days;
      }
    } else if (question.type === 'number') {
      minPrice += extras(question, question.min) * question.price;
      maxPrice += extras(question, question.max) * question.price;
      minDays += extras(question, question.min) * question.days;
      maxDays += extras(question, question.max) * question.days;
    }
  }
  return { minPrice, maxPrice, minDays, maxDays };
}

/** Why a form cannot be saved with this base, or null when every valid answer stays in bounds. */
export function serviceFormRangeError(form: ServiceRequestForm, base: Base) {
  const range = serviceFormRange(form, base);
  if (range.minPrice < SERVICE_PRICE_MIN)
    return `The cheapest answers must total at least ${SERVICE_PRICE_MIN} Buzz.`;
  if (range.maxPrice > SERVICE_PRICE_MAX)
    return `The dearest answers must total at most ${SERVICE_PRICE_MAX.toLocaleString()} Buzz.`;
  if (range.maxDays > SERVICE_DELIVERY_DAYS_MAX)
    return `Answers can add up to at most ${SERVICE_DELIVERY_DAYS_MAX} delivery days.`;
  return null;
}

export type ServiceFormPrice =
  | {
      ok: true;
      price: number;
      deliveryDays: number;
      breakdown: ServicePriceLine[];
      answers: ServiceFormAnswerLine[];
    }
  | { ok: false; error: string };

/**
 * The price and days these answers give, line by line. The buyer's page and the request share it,
 * so the total the buyer is shown is the total the deal takes.
 */
export function priceServiceRequest(
  form: ServiceRequestForm,
  base: Base,
  answers: ServiceFormAnswers
): ServiceFormPrice {
  const known = new Set(form.questions.map((question) => question.id));
  if (Object.keys(answers).some((key) => !known.has(key)))
    return { ok: false, error: 'An answer is for a question this form does not have.' };
  const breakdown: ServicePriceLine[] = [
    { label: 'Base', price: base.price, days: base.deliveryDays },
  ];
  const lines: ServiceFormAnswerLine[] = [];
  for (const question of form.questions) {
    const answer = answers[question.id];
    if (question.type === 'pickOne') {
      const option = question.options.find((candidate) => candidate.id === answer);
      if (!option) return { ok: false, error: `Pick an answer for "${question.label}".` };
      if (option.price || option.days) breakdown.push(priceLine(option));
      lines.push({ label: question.label, answer: option.label });
    } else if (question.type === 'pickAny') {
      const picked = answer === undefined ? [] : answer;
      if (!Array.isArray(picked) || new Set(picked).size !== picked.length)
        return { ok: false, error: `Check your answers to "${question.label}".` };
      const chosen = question.options.filter((option) => picked.includes(option.id));
      if (chosen.length !== picked.length)
        return { ok: false, error: `Check your answers to "${question.label}".` };
      for (const option of chosen)
        if (option.price || option.days) breakdown.push(priceLine(option));
      if (chosen.length)
        lines.push({
          label: question.label,
          answer: chosen.map((option) => option.label).join(', '),
        });
    } else if (question.type === 'number') {
      if (typeof answer !== 'number' || answer < question.min || answer > question.max)
        return {
          ok: false,
          error: `"${question.label}" must be from ${question.min} to ${question.max}.`,
        };
      const extra = extras(question, answer);
      if (extra && (question.price || question.days))
        breakdown.push({
          label: `${question.label}: ${extra} extra`,
          price: extra * question.price,
          days: extra * question.days,
        });
      lines.push({ label: question.label, answer: String(answer) });
    } else {
      const text = typeof answer === 'string' ? answer.trim() : answer === undefined ? '' : null;
      if (text === null) return { ok: false, error: `Check your answer to "${question.label}".` };
      if (question.required && !text) return { ok: false, error: `Answer "${question.label}".` };
      if (text) lines.push({ label: question.label, answer: text });
    }
  }
  const price = breakdown.reduce((sum, line) => sum + line.price, 0);
  const deliveryDays = breakdown.reduce((sum, line) => sum + line.days, 0);
  if (price < SERVICE_PRICE_MIN || price > SERVICE_PRICE_MAX)
    return { ok: false, error: 'These answers give a price this service cannot take.' };
  if (deliveryDays > SERVICE_DELIVERY_DAYS_MAX)
    return { ok: false, error: 'These answers give more delivery days than a service can take.' };
  return { ok: true, price, deliveryDays, breakdown, answers: lines };
}

/** The text answers, for the same check a request's text gets. */
export const serviceFormTextAnswers = (form: ServiceRequestForm, answers: ServiceFormAnswers) =>
  form.questions.flatMap((question) => {
    const answer = answers[question.id];
    return question.type === 'text' && typeof answer === 'string' && answer.trim()
      ? [answer.trim()]
      : [];
  });

/** The labels, for the offering's content check. */
export const serviceFormLabels = (form: ServiceRequestForm) =>
  form.questions.flatMap((question) => [
    question.label,
    ...('options' in question ? question.options.map((option) => option.label) : []),
  ]);
