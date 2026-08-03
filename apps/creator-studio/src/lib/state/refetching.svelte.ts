// Tracks in-flight non-navigation refetches (e.g. a CookieState change re-running the loads via invalidateAll),
// so the top progress bar can show feedback that `navigating.to` doesn't provide. Counter-based so overlapping
// refetches don't clear each other. Svelte 5 shared state: a class instance whose `$state` field is read reactively.
class Refetching {
  #count = $state(0);

  get active(): boolean {
    return this.#count > 0;
  }
  begin() {
    this.#count++;
  }
  end() {
    if (this.#count > 0) this.#count--;
  }
}

export const refetching = new Refetching();
