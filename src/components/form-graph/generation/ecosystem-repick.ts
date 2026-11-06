import type { StorageAdapter } from 'form-graph';
import { ecosystemRefusal } from '~/shared/form-graph/generation/ecosystem-gates';
import type { GenerationStore } from './store';

type EcosystemMeta = {
  hiddenEcosystems?: readonly string[];
  ecosystemStates?: readonly { key: string }[];
  usableEcosystems?: readonly string[];
  defaultEcosystem?: string;
};

/**
 * Where an ecosystem this viewer can't generate with falls back to: the field's
 * own default, so it lands where a fresh session would. Undefined keeps the
 * value, because it is available or because nothing is.
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

export type PreservingStorage = StorageAdapter & {
  /** Keep saving these stored entries while the store holds no value at their address. */
  preserve(entries: Record<string, unknown>): void;
};

const isEcosystemAddress = (address: string) =>
  address === 'ecosystem' || address.startsWith('ecosystem@');

/**
 * Storage that can keep a stored entry the store has cleared in memory. The
 * store has no non-persisting write: every save is its whole durable intent.
 * A preserved entry is written back on each save until the store writes that
 * address again, and from then on the new value is saved as usual.
 */
export function preservingStorage<S extends StorageAdapter>(
  inner: S | undefined
): (S & PreservingStorage) | undefined {
  if (!inner) return undefined;
  const held = new Map<string, unknown>();
  return {
    ...inner,
    save(intent) {
      if (!held.size) return inner.save(intent);
      const out = { ...intent };
      for (const [address, value] of [...held]) {
        if (address in intent) held.delete(address);
        else out[address] = value;
      }
      inner.save(out);
    },
    preserve(entries) {
      for (const [address, value] of Object.entries(entries)) held.set(address, value);
    },
  };
}

/**
 * One-shot, for when the gates first load: an ecosystem this viewer can't use
 * (default, stored, remixed or from a URL) is cleared in memory so the field
 * falls to its default, an adopted value the store never saves. The stored
 * choice is preserved, so it returns once the gate lifts. Later picks are not
 * touched: a disabled ecosystem stays selectable and the form explains it.
 */
export function correctUnavailableEcosystem(
  store: GenerationStore,
  storage?: PreservingStorage
): boolean {
  const field = store.getField('ecosystem');
  if (!field) return false;
  if (!unavailableEcosystemReplacement(field.value, field.meta as EcosystemMeta)) return false;
  const stored = Object.fromEntries(
    Object.entries(store.getIntent()).filter(([address]) => isEcosystemAddress(address))
  );
  storage?.preserve(stored);
  store.set({ ecosystem: undefined });
  return true;
}
