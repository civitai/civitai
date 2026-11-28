import { beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loadServiceOfferingSubjects } from '~/server/services/text-scan/profiles/service-offering.profile';

const ROW = {
  id: 3,
  sellerId: 7,
  title: 'Custom badge',
  description: 'One animated badge.',
  licenseCustomText: 'Print runs under 500 only.',
  declaredNsfwLevel: 1,
  maxNsfwLevel: 1,
  status: 'Active',
  requestForm: null as unknown,
};

// Returns only the selected columns, as the database does, so an unselected column reads as absent.
beforeEach(() => {
  dbMock.dbWrite.serviceOffering.findMany.mockImplementation((async ({
    select,
  }: {
    select: Record<string, boolean>;
  }) => [Object.fromEntries(Object.entries(ROW).filter(([key]) => select[key]))]) as never);
});

describe('loadServiceOfferingSubjects', () => {
  it("scans the seller's custom license text with the title and description", async () => {
    const subject = (await loadServiceOfferingSubjects([3])).get(3)!;
    expect(subject.fields).toEqual([
      { heading: 'Title', text: 'Custom badge' },
      { heading: 'Description', text: 'One animated badge.' },
      { heading: 'License terms', text: 'Print runs under 500 only.' },
    ]);
  });

  it('adds no license field to an offering without custom terms', async () => {
    ROW.licenseCustomText = null as never;
    try {
      const subject = (await loadServiceOfferingSubjects([3])).get(3)!;
      expect(subject.fields.map((f) => f.heading)).toEqual(['Title', 'Description']);
    } finally {
      ROW.licenseCustomText = 'Print runs under 500 only.';
    }
  });

  it("scans the request form's question and option labels", async () => {
    ROW.requestForm = {
      questions: [
        {
          type: 'pickOne',
          id: 'style',
          label: 'Style',
          options: [
            { id: 'a', label: 'Sketch', price: 0, days: 0 },
            { id: 'b', label: 'Full color', price: 500, days: 1 },
          ],
        },
        { type: 'text', id: 'brief', label: 'Describe your character', required: true },
      ],
    };
    try {
      const subject = (await loadServiceOfferingSubjects([3])).get(3)!;
      expect(subject.fields.at(-1)).toEqual({
        heading: 'Request form',
        text: 'Style\nSketch\nFull color\nDescribe your character',
      });
    } finally {
      ROW.requestForm = null;
    }
  });
});
