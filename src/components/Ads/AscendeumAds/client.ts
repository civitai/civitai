interface IAscendeum {
  cmd: Array<() => void>;
  processAdsOnPage: (adUnits?: string[]) => void;
  refresh: (elems?: HTMLElement[]) => void;
  refreshIds: (elemIds: string[]) => void;
  refreshAdunits: (adUnits: string[]) => void;
  destroy: (elems?: HTMLElement[]) => void;
  destroyIds: (elemIds: string[]) => void;
  destroyAdunits: (adunits: string[]) => void;
}

declare global {
  interface Window {
    asc: IAscendeum;
  }
}

class AscendeumAdManager implements IAscendeum {
  cmd = [];

  private push(fn: (asc: IAscendeum) => void) {
    const asc = (window.asc = window.asc || { cmd: [] });
    asc.cmd.push(function () {
      fn(asc);
    });
  }

  processAdsOnPage(adunits?: string[]) {
    (window.asc = window.asc || { cmd: [] }).cmd.push(function () {
      window.asc.processAdsOnPage(adunits);
    });
  }
  refresh(elems?: HTMLElement[] | undefined) {
    this.push((asc) => asc.refresh(elems));
  }
  refreshIds(elemIds: string[]) {
    this.push((asc) => asc.refreshIds(elemIds));
  }
  refreshAdunits(adUnits: string[]) {
    this.push((asc) => asc.refreshAdunits(adUnits));
  }
  destroy(elems?: HTMLElement[] | undefined) {
    this.push((asc) => asc.destroy(elems));
  }
  destroyIds(elemIds: string[]) {
    this.push((asc) => asc.destroyIds(elemIds));
  }
  destroyAdunits(adUnits: string[]) {
    this.push((asc) => asc.destroyAdunits(adUnits));
  }
}

export const ascAdManager = new AscendeumAdManager();
