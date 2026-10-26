/**
 * A window gets the generator's phone layout when its primary input is touch and it is narrow, or
 * short (a phone held sideways is wider than 768px). `pointer`, not `any-pointer`: a touch-screen
 * laptop's primary pointer is its trackpad, so a narrowed laptop window keeps the desktop layout.
 */
export const PHONE_MEDIA_QUERY =
  '(pointer: coarse) and (max-width: 767px), (pointer: coarse) and (max-height: 499px)';
