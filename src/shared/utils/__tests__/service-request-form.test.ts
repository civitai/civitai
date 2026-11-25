import { describe, expect, it } from 'vitest';
import type { ServiceRequestForm } from '~/shared/utils/service-request-form';
import {
  priceServiceRequest,
  serviceFormRange,
  serviceFormRangeError,
  serviceRequestFormSchema,
} from '~/shared/utils/service-request-form';

/** A character-art service: a base price, then answers that add to it. */
const BASE = { price: 2_000, deliveryDays: 4 };
const FORM: ServiceRequestForm = {
  questions: [
    {
      type: 'number',
      id: 'chars',
      label: 'How many characters?',
      min: 1,
      max: 4,
      included: 1,
      price: 1_500,
      days: 0,
    },
    {
      type: 'pickOne',
      id: 'style',
      label: 'Style',
      options: [
        { id: 'sketch', label: 'Sketch', price: 0, days: 0 },
        { id: 'color', label: 'Full color', price: 2_000, days: 0 },
      ],
    },
    {
      type: 'pickAny',
      id: 'extras',
      label: 'Extras',
      options: [
        { id: 'bg', label: 'Background', price: 1_000, days: 2 },
        { id: 'commercial', label: 'Commercial use', price: 3_000, days: 0 },
      ],
    },
    { type: 'text', id: 'brief', label: 'Describe your character', required: true },
  ],
};

describe('pricing a request from its answers', () => {
  it("gives the design's total, line by line", () => {
    const result = priceServiceRequest(FORM, BASE, {
      chars: 2,
      style: 'color',
      extras: ['bg'],
      brief: '  Red hair, a long coat  ',
    });
    expect(result).toEqual({
      ok: true,
      price: 6_500,
      deliveryDays: 6,
      breakdown: [
        { label: 'Base', price: 2_000, days: 4 },
        { label: 'How many characters?: 1 extra', price: 1_500, days: 0 },
        { label: 'Full color', price: 2_000, days: 0 },
        { label: 'Background', price: 1_000, days: 2 },
      ],
      answers: [
        { label: 'How many characters?', answer: '2' },
        { label: 'Style', answer: 'Full color' },
        { label: 'Extras', answer: 'Background' },
        { label: 'Describe your character', answer: 'Red hair, a long coat' },
      ],
    });
  });

  it('charges the base alone for the cheapest answers', () => {
    const result = priceServiceRequest(FORM, BASE, { chars: 1, style: 'sketch', brief: 'x' });
    expect(result).toMatchObject({ ok: true, price: 2_000, deliveryDays: 4 });
  });

  it.each([
    ['an option the question does not have', { chars: 1, style: 'oil', brief: 'x' }],
    ['a number above its largest', { chars: 5, style: 'sketch', brief: 'x' }],
    ['a required text left blank', { chars: 1, style: 'sketch', brief: '   ' }],
    ['the same extra twice', { chars: 1, style: 'sketch', extras: ['bg', 'bg'], brief: 'x' }],
  ])('refuses %s', (_name, answers) => {
    expect(priceServiceRequest(FORM, BASE, answers)).toMatchObject({ ok: false });
  });

  it('refuses answers whose total leaves the price bounds', () => {
    const form: ServiceRequestForm = {
      questions: [
        {
          type: 'number',
          id: 'n',
          label: 'Panels',
          min: 1,
          max: 100,
          included: 0,
          price: 20_000,
          days: 0,
        },
      ],
    };
    expect(priceServiceRequest(form, BASE, { n: 49 })).toMatchObject({ ok: true });
    expect(priceServiceRequest(form, BASE, { n: 50 })).toMatchObject({ ok: false });
  });
});

describe('the range a form can give', () => {
  it('runs from the cheapest valid answers to the dearest', () => {
    expect(serviceFormRange(FORM, BASE)).toEqual({
      minPrice: 2_000,
      maxPrice: 2_000 + 3 * 1_500 + 2_000 + 1_000 + 3_000,
      minDays: 4,
      maxDays: 6,
    });
  });

  it('counts what the smallest number needs past the included ones in the cheapest total', () => {
    const form: ServiceRequestForm = {
      questions: [
        {
          type: 'number',
          id: 'n',
          label: 'Panels',
          min: 3,
          max: 5,
          included: 1,
          price: 100,
          days: 1,
        },
      ],
    };
    expect(serviceFormRange(form, BASE)).toMatchObject({ minPrice: 2_200, minDays: 6 });
  });

  it('cannot be saved when the dearest answers pass the price cap, or the days cap', () => {
    expect(serviceFormRangeError(FORM, BASE)).toBeNull();
    const dear: ServiceRequestForm = {
      questions: [
        {
          type: 'pickOne',
          id: 'size',
          label: 'Size',
          options: [
            { id: 's', label: 'Small', price: 0, days: 0 },
            { id: 'l', label: 'Huge', price: 999_000, days: 0 },
          ],
        },
      ],
    };
    expect(serviceFormRangeError(dear, BASE)).toMatch(/at most/);
    const slow: ServiceRequestForm = {
      questions: [
        {
          type: 'pickAny',
          id: 'x',
          label: 'Extras',
          options: [{ id: 'a', label: 'Animation', price: 0, days: 57 }],
        },
      ],
    };
    expect(serviceFormRangeError(slow, BASE)).toMatch(/delivery days/);
  });
});

describe('a form a seller saves', () => {
  it('takes plain labels and refuses links or markup', () => {
    expect(serviceRequestFormSchema.safeParse(FORM).success).toBe(true);
    for (const label of ['see https://x.example', 'www.example.com', '<b>bold</b>'])
      expect(
        serviceRequestFormSchema.safeParse({
          questions: [{ type: 'text', id: 't', label, required: false }],
        }).success
      ).toBe(false);
  });
});
