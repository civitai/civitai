/** The claim key a box open grants its reward under: the server writes it, the reveal finds the hat by it. */
export const boxOpenClaimKey = (boxItemId: bigint | string) => `box-open-${boxItemId}`;
