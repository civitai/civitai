/**
 * Where a cropped image actually is inside the element that draws it.
 *
 * A placement is a fraction of the ARTWORK's bounds. An `<img>` under
 * `object-fit: cover` is a box the artwork is scaled and cropped INTO, so the
 * element's own `offsetWidth`/`offsetHeight` describe the hole, not the picture.
 * Mapping fractions onto the hole puts every sticker in the wrong place, by an
 * amount that grows with how much the card crops — which is why it was reported
 * from the featured feed, where a portrait image loses most of its height, and
 * never from the post page, where nothing is cropped at all.
 *
 * The maths is `object-fit`'s own: scale the artwork by the larger ratio for
 * `cover` and the smaller for `contain`, then place it with `object-position`.
 * The result deliberately OVERFLOWS the element for `cover` — that is the part
 * being cropped, and the overlay's container clips it, so a sticker placed on
 * the cropped-away part of the image is correctly not visible on the card.
 */
export type Rect = { width: number; height: number; left: number; top: number };

type Size = { width: number; height: number };

/** The scale `object-fit` applies, per its spec. */
const scaleFor = (fit: string, box: Size, natural: Size) => {
  const wide = box.width / natural.width;
  const tall = box.height / natural.height;

  switch (fit) {
    case 'cover':
      return Math.max(wide, tall);
    case 'contain':
      return Math.min(wide, tall);
    case 'none':
      return 1;
    // Whichever of `none` and `contain` is smaller — never enlarges.
    case 'scale-down':
      return Math.min(1, Math.min(wide, tall));
    // `fill` stretches to the box on both axes, so there is no single scale and
    // no crop: the drawn rect IS the element box. Handled by the caller.
    default:
      return null;
  }
};

/**
 * One axis of `object-position`, as a fraction of the free space.
 *
 * `getComputedStyle` resolves keywords to percentages (`top` becomes `50% 0%`),
 * so percentages are the common case. A length is an offset from the leading
 * edge rather than a proportion, which is the same distinction
 * `background-position` makes.
 */
const offsetFor = (value: string | undefined, free: number) => {
  if (!value) return free / 2;

  const percent = /^(-?[\d.]+)%$/.exec(value);
  if (percent) return (free * Number(percent[1])) / 100;

  const pixels = /^(-?[\d.]+)px$/.exec(value);
  if (pixels) return Number(pixels[1]);

  // Keywords, in case a browser hands them back unresolved.
  switch (value) {
    case 'left':
    case 'top':
      return 0;
    case 'right':
    case 'bottom':
      return free;
    case 'center':
      return free / 2;
    default:
      return free / 2;
  }
};

/**
 * The artwork's rectangle inside `box`, in the box's own coordinates.
 *
 * `left`/`top` are negative wherever the artwork is cropped — that is the point.
 * Returns the box unchanged when there is nothing to compute from: an unloaded
 * image has no natural size, and `fill` (the CSS default) draws to the box by
 * definition.
 */
export function mediaContentRect({
  box,
  natural,
  fit,
  position,
}: {
  box: Size;
  /** `naturalWidth`/`naturalHeight`, or a video's `videoWidth`/`videoHeight`. */
  natural: Size | null;
  /** Computed `object-fit`. */
  fit: string;
  /** Computed `object-position`, e.g. `"50% 0%"`. */
  position: string;
}): Rect {
  const asIs = { width: box.width, height: box.height, left: 0, top: 0 };

  // A natural size of 0 is an image that has not loaded. Guessing here would
  // paint every sticker in the wrong place for one frame and then correct it,
  // which reads as a glitch; the caller re-measures on load instead.
  if (!natural || natural.width <= 0 || natural.height <= 0) return asIs;

  const scale = scaleFor(fit, box, natural);
  if (scale == null) return asIs;

  const width = natural.width * scale;
  const height = natural.height * scale;
  const [x, y] = position.split(/\s+/);

  return {
    width,
    height,
    // `+ 0` normalises negative zero, which `0% ` of a zero overflow produces.
    // It styles identically but is a different value to `Object.is`, so without
    // this a test asserting the uncropped axis compares -0 against 0 and fails
    // on an equality nobody can see.
    left: offsetFor(x, box.width - width) + 0,
    top: offsetFor(y, box.height - height) + 0,
  };
}

/** `mediaContentRect` for a live element, reading the values off the DOM. */
export function mediaContentRectOf(element: HTMLElement): Rect {
  const style = getComputedStyle(element);

  const natural =
    element instanceof HTMLImageElement
      ? { width: element.naturalWidth, height: element.naturalHeight }
      : element instanceof HTMLVideoElement
      ? { width: element.videoWidth, height: element.videoHeight }
      : null;

  return mediaContentRect({
    box: { width: element.offsetWidth, height: element.offsetHeight },
    natural,
    fit: style.objectFit,
    position: style.objectPosition,
  });
}
