export class Limiter {
  private active = 0;
  private readonly queue: (() => void)[] = [];
  constructor(readonly maximum: number) {
    if (!Number.isInteger(maximum) || maximum < 1) throw new Error('Invalid concurrency limit');
  }
  async run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const start = () => {
        signal.removeEventListener('abort', abort);
        this.active++; resolve();
      };
      const abort = () => {
        const index = this.queue.indexOf(start);
        if (index >= 0) this.queue.splice(index, 1);
        reject(signal.reason);
      };
      if (this.active < this.maximum) start();
      else { this.queue.push(start); signal.addEventListener('abort', abort, { once: true }); }
    });
    try { signal.throwIfAborted(); return await operation(); }
    finally { this.active--; this.queue.shift()?.(); }
  }
}
