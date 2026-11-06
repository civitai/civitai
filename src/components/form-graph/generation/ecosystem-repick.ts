import { ecosystemRefusal } from '~/shared/form-graph/generation/ecosystem-gates';
import type { GenerationStore } from './store';

type EcosystemMeta = {
  hiddenEcosystems?: readonly string[];
  ecosystemStates?: readonly { key: string }[];
  usableEcosystems?: readonly string[];
  defaultEcosystem?: string;
};

/**
 * The ecosystem to move to when `value` is one this viewer can't generate with:
 * the field's own default, so it lands where a fresh session would. Undefined
 * keeps the value — it is available, or nothing is.
 */
export function unavailableEcosystemReplacement(
  value: unknown,
  meta: EcosystemMeta | undefined
): string | undefined {
  if (typeof value !== 'string' || !meta) return undefined;
  const isRefused = ecosystemRefusal(
    meta.hiddenEcosystems ?? [],
    (meta.ecosystemStates ?? []).map((e) => e.key)
  );
  if (!isRefused(value)) return undefined;
  const target = meta.defaultEcosystem;
  if (!target || !meta.usableEcosystems?.includes(target)) return undefined;
  return target;
}

/**
 * Moves a stored, remixed or picked ecosystem off one that has become
 * unavailable (gate rules and the self-hosted toggle load after the store does).
 * An adopted default needs no help: `setExt` re-derives it. Returns the
 * unsubscribe.
 */
export function repickUnavailableEcosystem(store: GenerationStore): () => void {
  const check = () => {
    const field = store.getField('ecosystem');
    if (!field) return;
    const target = unavailableEcosystemReplacement(field.value, field.meta as EcosystemMeta);
    if (target) store.set({ ecosystem: target });
  };
  check();
  return store.subscribe(check);
}
