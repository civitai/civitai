import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { requireAccess } from '$lib/server/access';
import { int4Id, parseForm } from '$lib/server/query';
import {
  addCoreImage,
  getCoreItems,
  getCoreSetCounts,
  getFreshItems,
  getSpotCheckItems,
  promoteToCore,
  retireReference,
  spotCheckItem,
  updateCoreItem,
  type Outcome,
} from '$lib/server/knights/coreset.service';
import { CORESET } from '$lib/server/knights/coreset.config';
import {
  addYesNoReference,
  deleteYesNoReference,
  getYesNoQuestions,
  getYesNoReferenceCount,
  getYesNoReferences,
  setYesNoReferenceActive,
} from '$lib/server/knights/yesno-reference.service';

const TABS = ['core', 'fresh', 'spot-check', 'yes-no'] as const;
type Tab = (typeof TABS)[number];

const level = z.coerce.number().int();
const why = z.string().max(2000);

/** An image id, or any civitai image page URL (`/images/<id>`). */
const imageRef = z.preprocess((value) => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (/^\d+$/.test(text)) return Number(text);
  const fromUrl = text.match(/\/images\/(\d+)(?:[/?#]|$)/);
  return fromUrl ? Number(fromUrl[1]) : NaN;
}, z.number({ error: 'Enter an image id or an image page URL.' }).pipe(int4Id));
const yesNo = z.enum(['yes', 'no']).transform((value) => value === 'yes');

const forms = {
  addYesNo: z.object({
    image: imageRef,
    questionKey: z.string().trim().min(1).max(200),
    answer: yesNo,
    explanation: why.optional().default(''),
  }),
  toggleYesNo: z.object({
    id: int4Id,
    active: z.enum(['true', 'false']).transform((v) => v === 'true'),
  }),
  deleteYesNo: z.object({ id: int4Id }),
  add: z.object({ imageId: int4Id, level, explanation: why }),
  update: z.object({ id: int4Id, level, explanation: why }),
  retire: z.object({ id: int4Id }),
  promote: z.object({ id: int4Id, explanation: why.optional().default('') }),
  spotCheck: z.object({ id: int4Id, level }),
};

export const load: PageServerLoad = async ({ url, locals }) => {
  requireAccess(locals.user, url.pathname);
  const requested = url.searchParams.get('tab');
  const tab: Tab = TABS.find((t) => t === requested) ?? 'core';
  const [counts, yesNoCount] = await Promise.all([getCoreSetCounts(), getYesNoReferenceCount()]);
  return {
    tab,
    counts: { ...counts, yesNo: yesNoCount },
    limit: CORESET.listLimit,
    flagRule: { minAnswers: CORESET.flagMinAnswers, failureRate: CORESET.flagFailureRate },
    items: tab === 'core' ? await getCoreItems() : tab === 'fresh' ? await getFreshItems() : [],
    spotCheck: tab === 'spot-check' ? await getSpotCheckItems() : [],
    yesNo:
      tab === 'yes-no'
        ? { items: await getYesNoReferences(), questions: await getYesNoQuestions() }
        : { items: [], questions: [] },
  };
};

async function run<S extends z.ZodType>(
  event: { request: Request; locals: App.Locals; url: URL },
  schema: S,
  label: string,
  act: (
    input: z.infer<S>
  ) => Promise<Outcome | { ok: true; agreed: boolean } | { ok: false; error: string }>
) {
  requireAccess(event.locals.user, event.url.pathname);
  const input = parseForm(schema, await event.request.formData());
  if (typeof input === 'string') return fail(400, { error: input });
  try {
    const result = await act(input);
    if (!result.ok) return fail(409, { error: result.error });
    return { success: true, agreed: 'agreed' in result ? result.agreed : undefined };
  } catch (error) {
    console.error(`knights trials: could not ${label}`, { error });
    return fail(500, { error: `Could not ${label}. Nothing was changed; try again.` });
  }
}

export const actions: Actions = {
  add: (event) => run(event, forms.add, 'add the image', addCoreImage),
  update: (event) => run(event, forms.update, 'save the change', updateCoreItem),
  retire: (event) => run(event, forms.retire, 'retire the image', ({ id }) => retireReference(id)),
  promote: (event) => run(event, forms.promote, 'promote the image', promoteToCore),
  spotCheck: (event) => run(event, forms.spotCheck, 'record the rating', spotCheckItem),
  addYesNo: (event) =>
    run(event, forms.addYesNo, 'add the pair', ({ image, ...rest }) =>
      addYesNoReference({ ...rest, imageId: image, createdBy: event.locals.user?.id ?? 0 })
    ),
  toggleYesNo: (event) =>
    run(event, forms.toggleYesNo, 'update the pair', ({ id, active }) =>
      setYesNoReferenceActive(id, active)
    ),
  deleteYesNo: (event) =>
    run(event, forms.deleteYesNo, 'delete the pair', ({ id }) => deleteYesNoReference(id)),
};
