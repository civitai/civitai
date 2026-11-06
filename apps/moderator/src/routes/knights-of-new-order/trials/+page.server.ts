import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { requireAccess } from '$lib/server/access';
import { int4Id, parseForm, parseQuery } from '$lib/server/query';
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
import { CORESET, type ListPage, type ListQuery } from '$lib/server/knights/coreset.config';
import { BAD_IMAGE, imageRef, parseImageRef } from './image-ref';
import {
  addYesNoReference,
  deleteYesNoReference,
  getYesNoQuestions,
  getYesNoReferenceCount,
  getYesNoReferences,
  setYesNoReferenceActive,
  updateYesNoReference,
} from '$lib/server/knights/yesno-reference.service';

const TABS = ['core', 'fresh', 'spot-check', 'yes-no'] as const;
type Tab = (typeof TABS)[number];

const level = z.coerce.number().int();
const why = z.string().max(2000);
const question = z.string().trim().min(1, 'Write the question Acolytes will be asked.').max(600);

const yesNo = z.enum(['yes', 'no']).transform((value) => value === 'yes');

const forms = {
  addYesNo: z.object({
    image: imageRef,
    questionKey: z.string().trim().min(1).max(200),
    prompt: question,
    answer: yesNo,
    explanation: why.optional().default(''),
  }),
  toggleYesNo: z.object({
    id: int4Id,
    active: z.enum(['true', 'false']).transform((v) => v === 'true'),
  }),
  updateYesNo: z.object({
    id: int4Id,
    prompt: question,
    answer: yesNo,
    explanation: why.optional().default(''),
  }),
  deleteYesNo: z.object({ id: int4Id }),
  add: z.object({ imageId: int4Id, level, explanation: why }),
  update: z.object({ id: int4Id, level, explanation: why }),
  retire: z.object({ id: int4Id }),
  promote: z.object({ id: int4Id, explanation: why.optional().default('') }),
  spotCheck: z.object({ id: int4Id, level }),
};

const query = z.object({
  tab: z.enum(TABS).catch('core'),
  page: z.coerce.number().int().positive().max(100_000).catch(1),
  q: z.string().trim().max(500).catch(''),
});

const blank = <T>(): ListPage<T> => ({ items: [], total: 0, page: 1 });

export const load: PageServerLoad = async ({ url, locals }) => {
  requireAccess(locals.user, url.pathname);
  const { tab, page, q } = parseQuery(url, query);
  const imageId = q ? parseImageRef(q) : null;
  const searchError = q && imageId === null ? BAD_IMAGE : null;
  const list: ListQuery = imageId === null ? { page } : { page, imageId };
  const read = <T>(wanted: Tab, get: (q: ListQuery) => Promise<ListPage<T>>) =>
    tab === wanted && !searchError ? get(list) : Promise.resolve(blank<T>());

  const [counts, yesNoCount] = await Promise.all([getCoreSetCounts(), getYesNoReferenceCount()]);
  const core = await read('core', getCoreItems);
  const fresh = await read('fresh', getFreshItems);
  const spotCheck = await read('spot-check', getSpotCheckItems);
  const yesNo = await read('yes-no', getYesNoReferences);
  const shown = { core, fresh, 'spot-check': spotCheck, 'yes-no': yesNo }[tab];
  return {
    tab,
    search: { text: q, error: searchError },
    pageSize: CORESET.pageSize,
    paging: { page: shown.page, total: shown.total },
    counts: { ...counts, yesNo: yesNoCount },
    flagRule: { minAnswers: CORESET.flagMinAnswers, failureRate: CORESET.flagFailureRate },
    items: tab === 'core' ? core.items : fresh.items,
    spotCheck: spotCheck.items,
    yesNo: { items: yesNo.items, questions: tab === 'yes-no' ? await getYesNoQuestions() : [] },
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
  updateYesNo: (event) =>
    run(event, forms.updateYesNo, 'save the pair', ({ id, ...rest }) =>
      updateYesNoReference(id, rest)
    ),
  deleteYesNo: (event) =>
    run(event, forms.deleteYesNo, 'delete the pair', ({ id }) => deleteYesNoReference(id)),
};
