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

const HORIZONTAL = new Set(['left', 'right']);
const VERTICAL = new Set(['top', 'bottom']);

/**
 * One axis of `object-position`, as a fraction of the free space — or `null`
 * where the value is not one this understands.
 *
 * `null` matters more than the arithmetic does. Every unparsed value used to
 * fall back to centring, which is a confident answer to a question this could
 * not read: `calc(50% + 10px)` is a legal computed value, and centring it puts
 * every sticker somewhere plausible and wrong. The caller returns the element
 * box instead, which is the pre-fix behaviour — wrong in the same direction it
 * has always been wrong, rather than newly and differently wrong.
 */
const offsetFor = (value: string | undefined, free: number) => {
  if (!value) return null;

  const percent = /^(-?[\d.]+)%$/.exec(value);
  if (percent) return (free * Number(percent[1])) / 100;

  // Computed style resolves em/rem/vh to px, so this covers every length that
  // survives to this point.
  const pixels = /^(-?[\d.]+)px$/.exec(value);
  if (pixels) return Number(pixels[1]);

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
      return null;
  }
};

/**
 * The two axes of `object-position`, in x-then-y order.
 *
 * Keywords may be written either way round — `object-position: top center` is
 * the literal value in `Cards.module.css` — so a positional read of the tokens
 * maps `top` onto x and lands the artwork at the left edge. Browsers normally
 * resolve both to percentages before this sees them; this is for the case where
 * one does not.
 *
 * Anything with more than two tokens (`right 20px bottom 10px`) is refused
 * rather than truncated: reading the first two of four gives a number that is
 * confidently wrong on both axes.
 */
const axesOf = (position: string) => {
  const tokens = position.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length || tokens.length > 2) return null;

  const [first, second] = tokens;
  if (tokens.length === 1) return VERTICAL.has(first) ? ['center', first] : [first, 'center'];

  // Written the other way round, which CSS allows for keyword pairs.
  if (VERTICAL.has(first) || HORIZONTAL.has(second)) return [second, first];
  return [first, second];
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

  const axes = axesOf(position);
  if (!axes) return asIs;

  const left = offsetFor(axes[0], box.width - width);
  const top = offsetFor(axes[1], box.height - height);
  if (left == null || top == null) return asIs;

  return {
    width,
    height,
    // `+ 0` normalises negative zero, which `0%` of a zero overflow produces.
    // It styles identically but is a different value to `Object.is`, so without
    // it a test asserting the uncropped axis compares -0 against 0 and fails on
    // an equality nobody can see.
    left: left + 0,
    top: top + 0,
  };
}

/**
 * `mediaContentRect` for a live element, reading the values off the DOM.
 *
 * The box is the CONTENT box, not `offsetWidth`/`offsetHeight`. `object-fit`
 * fits the content box, so padding or a border on the media would otherwise
 * make the artwork rect too large and shift every sticker by the border width —
 * silently, and only on cropped cards. Nothing sets either today; the card
 * wrapper beside it already carries a border, and one stylesheet change moves
 * it onto the media.
 *
 * The returned rect is in the ELEMENT's coordinates (border box), so the
 * content box's own inset is added back.
 */
export function mediaContentRectOf(element: HTMLElement): Rect {
  const style = getComputedStyle(element);

  const natural =
    element instanceof HTMLImageElement
      ? { width: element.naturalWidth, height: element.naturalHeight }
      : element instanceof HTMLVideoElement
      ? { width: element.videoWidth, height: element.videoHeight }
      : null;

  const px = (value: string) => parseFloat(value) || 0;
  const insetLeft = px(style.borderLeftWidth) + px(style.paddingLeft);
  const insetTop = px(style.borderTopWidth) + px(style.paddingTop);
  const contentWidth =
    element.clientWidth > 0
      ? element.clientWidth - px(style.paddingLeft) - px(style.paddingRight)
      : element.offsetWidth;
  const contentHeight =
    element.clientHeight > 0
      ? element.clientHeight - px(style.paddingTop) - px(style.paddingBottom)
      : element.offsetHeight;

  const rect = mediaContentRect({
    box: { width: contentWidth, height: contentHeight },
    natural,
    fit: style.objectFit,
    position: style.objectPosition,
  });

  return { ...rect, left: rect.left + insetLeft, top: rect.top + insetTop };
}
