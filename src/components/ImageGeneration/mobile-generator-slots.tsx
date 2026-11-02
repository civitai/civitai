import createSlots from '~/libs/slots/create-slots';

/** Places in the mobile generator's own chrome that the form fills: Reset in the title row. */
export const {
  SlotProvider: MobileGeneratorSlots,
  TitleActions,
  RenderTitleActions,
} = createSlots(['titleActions']);
