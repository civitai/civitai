import { CSAM_CONTEXT_ITEM_SELECT_LIMIT } from '~/shared/constants/csam-context.constants';

export type ItemSource = 'model' | 'article' | 'serviceOffering';
export type IdField = 'chatMessageIds' | 'modelIds' | 'articleIds' | 'serviceOfferingIds';
export const ITEMS: { source: ItemSource; field: IdField; label: string }[] = [
  { source: 'model', field: 'modelIds', label: 'Models' },
  { source: 'article', field: 'articleIds', label: 'Articles' },
  { source: 'serviceOffering', field: 'serviceOfferingIds', label: 'Service offerings' },
];

const tokens = (raw: string) => raw.split(/[\s,]+/).filter(Boolean);
const isId = (token: string) => /^[1-9][0-9]{0,9}$/.test(token) && Number(token) <= 2147483647;
export const parseIds = (raw: string) => [...new Set(tokens(raw).filter(isId).map(Number))];
export const badTokens = (raw: string) => tokens(raw).filter((token) => !isId(token));
const union = (a: number[], b: number[]) => [...new Set([...a, ...b])];

export type Typed = Record<IdField, string>;
export type Ticked = Record<ItemSource, number[]>;

/**
 * What the picker would send, and why it can't be filed yet: a typed token that is not an id, or more
 * items than one filing may select.
 */
export function csamPickerState(typed: Typed, ticked: Ticked, profile: boolean) {
  const lists = {
    chatMessageIds: parseIds(typed.chatMessageIds),
    modelIds: union(ticked.model, parseIds(typed.modelIds)),
    articleIds: union(ticked.article, parseIds(typed.articleIds)),
    serviceOfferingIds: union(ticked.serviceOffering, parseIds(typed.serviceOfferingIds)),
  };
  const count = Object.values(lists).reduce((n, ids) => n + ids.length, 0) + (profile ? 1 : 0);
  const bad = Object.values(typed).flatMap(badTokens);
  const problem = bad.length
    ? `Not an id: ${bad.join(', ')}. Fix or remove it to file.`
    : count > CSAM_CONTEXT_ITEM_SELECT_LIMIT
    ? `${count} items selected. One report can attach at most ${CSAM_CONTEXT_ITEM_SELECT_LIMIT}.`
    : undefined;
  return { lists, count, problem };
}

/** Unticking also takes the id out of the typed box, so nothing unticked is sent. */
export function csamUntick(ticked: number[], typed: string, id: number) {
  return {
    ticked: ticked.filter((x) => x !== id),
    typed: tokens(typed)
      .filter((token) => Number(token) !== id)
      .join(', '),
  };
}
