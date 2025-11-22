import { ImageFlags } from '~/server/common/enums';
import { FlagsBitmask } from '~/shared/utils/flags';

/**
 * Helper class to work with ImageFlags bitmask.
 * Extends FlagsBitmask with convenient named getters/setters for each flag.
 *
 * @example
 * // Reading flags from database
 * const image = await db.image.findUnique({ where: { id }, select: { flags: true } });
 * const flags = new ImageFlagsBitmask(image.flags);
 * if (flags.nsfwLevelLocked) { ... }
 *
 * @example
 * // Writing flags to database
 * const flags = new ImageFlagsBitmask(image.flags);
 * flags.nsfwLevelLocked = true;
 * await db.image.update({ where: { id }, data: { flags: flags.value } });
 *
 * @example
 * // Using generic methods
 * const flags = new ImageFlagsBitmask(image.flags);
 * flags.has(ImageFlags.minor); // true/false
 * flags.set(ImageFlags.poi).unset(ImageFlags.minor);
 */
export class ImageFlagsBitmask extends FlagsBitmask<typeof ImageFlags> {
  constructor(flags = 0) {
    super(flags);
  }

  // Named getters and setters for convenient access
  get nsfwLevelLocked(): boolean {
    return this.has(ImageFlags.nsfwLevelLocked);
  }
  set nsfwLevelLocked(v: boolean) {
    this.set(ImageFlags.nsfwLevelLocked, v);
  }

  get tosViolation(): boolean {
    return this.has(ImageFlags.tosViolation);
  }
  set tosViolation(v: boolean) {
    this.set(ImageFlags.tosViolation, v);
  }

  get hideMeta(): boolean {
    return this.has(ImageFlags.hideMeta);
  }
  set hideMeta(v: boolean) {
    this.set(ImageFlags.hideMeta, v);
  }

  get minor(): boolean {
    return this.has(ImageFlags.minor);
  }
  set minor(v: boolean) {
    this.set(ImageFlags.minor, v);
  }

  get poi(): boolean {
    return this.has(ImageFlags.poi);
  }
  set poi(v: boolean) {
    this.set(ImageFlags.poi, v);
  }

  get acceptableMinor(): boolean {
    return this.has(ImageFlags.acceptableMinor);
  }
  set acceptableMinor(v: boolean) {
    this.set(ImageFlags.acceptableMinor, v);
  }

  get promptNsfw(): boolean {
    return this.has(ImageFlags.promptNsfw);
  }
  set promptNsfw(v: boolean) {
    this.set(ImageFlags.promptNsfw, v);
  }

  get resourcesNsfw(): boolean {
    return this.has(ImageFlags.resourcesNsfw);
  }
  set resourcesNsfw(v: boolean) {
    this.set(ImageFlags.resourcesNsfw, v);
  }

  get hasPrompt(): boolean {
    return this.has(ImageFlags.hasPrompt);
  }
  set hasPrompt(v: boolean) {
    this.set(ImageFlags.hasPrompt, v);
  }

  get madeOnSite(): boolean {
    return this.has(ImageFlags.madeOnSite);
  }
  set madeOnSite(v: boolean) {
    this.set(ImageFlags.madeOnSite, v);
  }

  /** Create a new instance from an existing flags value */
  static from(flags: number | null | undefined): ImageFlagsBitmask {
    return new ImageFlagsBitmask(flags ?? 0);
  }
}
