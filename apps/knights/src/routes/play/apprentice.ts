import { imageUrl } from '$lib/server/image-url';
import { APPRENTICE } from '$lib/server/apprenticeship/config';
import type {
  ApprenticeProgress,
  ApprenticeView,
} from '$lib/server/apprenticeship/apprenticeship.service';

/** The player's standing as the page receives it. */
function progressPayload(progress: ApprenticeProgress) {
  return {
    answered: progress.answered,
    graded: progress.graded,
    accuracy: progress.accuracy,
    bar: APPRENTICE.accuracyBar,
    knightLevel: APPRENTICE.knightLevel,
  };
}

/** The apprenticeship as the page receives it: pictures as URLs, and never an answer the player has not given. */
export function apprenticePayload(view: Exclude<ApprenticeView, { kind: 'not-acolyte' }>) {
  const progress = progressPayload(view.progress);
  switch (view.kind) {
    case 'question':
      return {
        kind: 'question' as const,
        progress,
        prompt: view.item.prompt,
        options: view.item.options,
        item: {
          kind: view.item.kind,
          referenceId: view.item.referenceId,
          src: imageUrl(view.item.imageKey),
          width: view.item.width,
          height: view.item.height,
        },
      };
    case 'checkpoint':
      return {
        kind: 'checkpoint' as const,
        progress,
        total: view.checkpoint.total,
        right: view.checkpoint.right,
        coach: view.checkpoint.coach,
        missed: view.checkpoint.missed.map((miss) => ({
          key: `${miss.kind}:${miss.referenceId}`,
          src: miss.imageKey ? imageUrl(miss.imageKey) : null,
          width: miss.width,
          height: miss.height,
          answerLabel: miss.answerLabel,
          correctLabel: miss.correctLabel,
          explanation: miss.explanation,
        })),
      };
    case 'exhausted':
      return { kind: 'exhausted' as const, progress };
  }
}

export type ApprenticeData = ReturnType<typeof apprenticePayload>;
