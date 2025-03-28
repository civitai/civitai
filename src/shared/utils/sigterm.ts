class SIGTERM {
  private _handlers: VoidFunction[] = [];

  push(fn: VoidFunction) {
    this._handlers.push(fn);
  }

  get handlers() {
    return this._handlers;
  }

  async cleanup() {
    await Promise.all(
      this._handlers.map(async (handler) => {
        await handler();
      })
    );
    this._handlers = [];
  }
}

export const instance = new SIGTERM();
export { instance as SIGTERM };
