import { describe, expect, it } from 'vitest';
import { csamPickerState, csamUntick } from '~/components/Csam/csam-item-picker';
import { CSAM_CONTEXT_ITEM_SELECT_LIMIT } from '~/shared/constants/csam-context.constants';

const noTyped = { chatMessageIds: '', modelIds: '', articleIds: '', serviceOfferingIds: '' };
const noTicked = { model: [], article: [], serviceOffering: [] };

describe('the CSAM report item picker', () => {
  it('sends exactly what was ticked and typed, once each', () => {
    const { lists, count, problem } = csamPickerState(
      { ...noTyped, chatMessageIds: '901, 902 901', modelIds: '7 123' },
      { ...noTicked, model: [7, 12] },
      true
    );
    expect(lists).toEqual({
      chatMessageIds: [901, 902],
      modelIds: [7, 12, 123],
      articleIds: [],
      serviceOfferingIds: [],
    });
    expect(count).toBe(6);
    expect(problem).toBeUndefined();
  });

  it('blocks filing on a typed token that is not an id, rather than dropping it', () => {
    const { lists, problem } = csamPickerState(
      { ...noTyped, chatMessageIds: '#901 https://civitai.com/chat/5 902 0 99999999999' },
      noTicked,
      false
    );
    expect(lists.chatMessageIds).toEqual([902]);
    expect(problem).toBe(
      'Not an id: #901, https://civitai.com/chat/5, 0, 99999999999. Fix or remove it to file.'
    );
  });

  it('blocks filing past the limit, counting the profile', () => {
    const ids = Array.from({ length: CSAM_CONTEXT_ITEM_SELECT_LIMIT }, (_, i) => i + 1);
    expect(csamPickerState(noTyped, { ...noTicked, model: ids }, false).problem).toBeUndefined();
    expect(csamPickerState(noTyped, { ...noTicked, model: ids }, true).problem).toBe(
      `${
        CSAM_CONTEXT_ITEM_SELECT_LIMIT + 1
      } items selected. One report can attach at most ${CSAM_CONTEXT_ITEM_SELECT_LIMIT}.`
    );
  });

  it('takes an unticked id out of the typed box too, so it is not sent', () => {
    const untick = csamUntick([12, 7], '7, 123', 7);
    expect(untick).toEqual({ ticked: [12], typed: '123' });
    const { lists } = csamPickerState(
      { ...noTyped, modelIds: untick.typed },
      { ...noTicked, model: untick.ticked },
      false
    );
    expect(lists.modelIds).toEqual([12, 123]);
  });
});
