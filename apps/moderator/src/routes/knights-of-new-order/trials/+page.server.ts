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
import { YESNO_PROMPT_MAX } from '$lib/knights/trials-limits';
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
import {
  getYesNoAxes,
  getYesNoQuestionItems,
  retireYesNoQuestion,
  rewordYesNoQuestion,
  unretireYesNoQuestion,
  YESNO_QUESTION_STATUSES,
  type YesNoQuestionItem,
  type YesNoQuestionQuery,
} from '$lib/server/knights/yesno-question.service';

const TABS = ['core', 'fresh', 'spot-check', 'yes-no', 'questions'] as const;
type Tab = (typeof TABS)[number];

const level = z.coerce.number().int();
const why = z.string().max(2000);
const question = z
  .string()
  .trim()
  .min(1, 'Write the question Acolytes will be asked.')
  .max(YESNO_PROMPT_MAX);

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
  retireQuestion: z.object({ id: int4Id, note: z.string().trim() }),
  unretireQuestion: z.object({ id: int4Id }),
  rewordQuestion: z.object({ id: int4Id, prompt: z.string().trim(), note: z.string().trim() }),
  add: z.object({ image: imageRef, level, explanation: why }),
  update: z.object({ id: int4Id, level, explanation: why }),
  retire: z.object({ id: int4Id }),
  promote: z.object({ id: int4Id, explanation: why.optional().default('') }),
  spotCheck: z.object({ id: int4Id, level }),
};

const query = z.object({
  tab: z.enum(TABS).catch('core'),
  page: z.coerce.number().int().positive().max(100_000).catch(1),
  q: z.string().trim().max(500).catch(''),
  axis: z.string().trim().max(200).catch(''),
  status: z.enum(YESNO_QUESTION_STATUSES).catch('open'),
});

const blank = <T>(): ListPage<T> => ({ items: [], total: 0, page: 1 });

const AXIS_PREFIX = 'knights.yesno.';

export const load: PageServerLoad = async ({ url, locals }) => {
  requireAccess(locals.user, url.pathname);
  const parsed = parseQuery(url, query);
  const { tab, page, q } = parsed;
  const questionsTab = tab === 'questions';
  const axis = questionsTab ? parsed.axis : '';
  const status = questionsTab ? parsed.status : 'open';
  const imageId = q ? parseImageRef(q) : null;
  // The question list also searches the prompt, so text that is not an image reference is not an error there.
  const searchError = q && imageId === null && !questionsTab ? BAD_IMAGE : null;
  const list: ListQuery = imageId === null ? { page } : { page, imageId };
  const read = <T>(wanted: Tab, get: (q: ListQuery) => Promise<ListPage<T>>) =>
    tab === wanted && !searchError ? get(list) : Promise.resolve(blank<T>());

  // A bare number is an image id or a number in the question; a URL is only ever an image.
  const questionQuery = (): YesNoQuestionQuery => {
    const base = { page, status, axis: axis || undefined };
    if (!q) return base;
    if (imageId === null) return { ...base, search: { text: q } };
    return /^\d+$/.test(q) ? { ...base, search: { text: q, imageId } } : { ...base, imageId };
  };

  const [counts, yesNoCount, core, fresh, spotCheck, yesNo, questions, queue, axes] =
    await Promise.all([
      getCoreSetCounts(),
      getYesNoReferenceCount(),
      read('core', getCoreItems),
      read('fresh', getFreshItems),
      read('spot-check', getSpotCheckItems),
      read('yes-no', getYesNoReferences),
      tab === 'yes-no' ? getYesNoQuestions() : Promise.resolve([]),
      questionsTab
        ? getYesNoQuestionItems(questionQuery())
        : Promise.resolve(blank<YesNoQuestionItem>()),
      questionsTab ? getYesNoAxes() : Promise.resolve([]),
    ]);
  const shown = { core, fresh, 'spot-check': spotCheck, 'yes-no': yesNo, questions: queue }[tab];
  return {
    tab,
    search: { text: q, error: searchError },
    pageSize: CORESET.pageSize,
    paging: { page: shown.page, total: shown.total },
    counts: { ...counts, yesNo: yesNoCount },
    flagRule: { minAnswers: CORESET.flagMinAnswers, failureRate: CORESET.flagFailureRate },
    items: tab === 'core' ? core.items : fresh.items,
    spotCheck: spotCheck.items,
    yesNo: { items: yesNo.items, questions },
    questionQueue: {
      items: queue.items,
      axes: axes.map((a) => ({ key: a.key, label: a.key.replace(AXIS_PREFIX, '') })),
      filters: { axis, status },
    },
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
  add: (event) =>
    run(event, forms.add, 'add the image', ({ image, ...rest }) =>
      addCoreImage({ ...rest, imageId: image })
    ),
  update: (event) => run(event, forms.update, 'save the change', updateCoreItem),
  retire: (event) => run(event, forms.retire, 'retire the image', ({ id }) => retireReference(id)),
  promote: (event) => run(event, forms.promote, 'promote the image', promoteToCore),
  spotCheck: (event) => run(event, forms.spotCheck, 'record the rating', spotCheckItem),
  addYesNo: (event) =>
    run(event, forms.addYesNo, 'add the pair', ({ image, ...rest }) =>
      addYesNoReference({ ...rest, imageId: image, createdBy: event.locals.user!.id })
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
  retireQuestion: (event) =>
    run(event, forms.retireQuestion, 'retire the question', (input) =>
      retireYesNoQuestion({ ...input, by: event.locals.user!.id })
    ),
  unretireQuestion: (event) =>
    run(event, forms.unretireQuestion, 'restore the question', ({ id }) =>
      unretireYesNoQuestion({ id, by: event.locals.user!.id })
    ),
  rewordQuestion: (event) =>
    run(event, forms.rewordQuestion, 'reword the question', (input) =>
      rewordYesNoQuestion({ ...input, by: event.locals.user!.id })
    ),
};
