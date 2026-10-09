// Which donation-event sections the event page shows. A scored event renders ScoredEventSections
// instead, so none of these apply to it: their copy (garland, team bank, charity) is about a
// donation event and would describe the wrong game.
export function donationEventSections({
  scored,
  equipped,
  ended,
}: {
  scored: boolean;
  equipped: boolean;
  ended: boolean;
}) {
  if (scored) return { welcome: false, donation: false, about: false };
  return { welcome: !equipped && !ended, donation: true, about: equipped || ended };
}
