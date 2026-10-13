import { ApiError } from '../http/errors.js';

/** All HTTP writes participate, including async collectors and agent writes. */
export class Maintenance {
  private active = 0;
  private waiting: Array<() => void> = [];
  locked = false;
  enter(): () => void {
    if (this.locked) throw new ApiError(503, 'maintenance', '正在恢复数据，请稍后重试。');
    this.active++;
    let left = false;
    return () => { if (left) return; left = true; if (--this.active === 0) this.waiting.splice(0).forEach(fn => fn()); };
  }
  get busy(): boolean { return this.active > 0 || this.locked; }
  async exclusive<T>(run: () => T | Promise<T>): Promise<T> {
    if (this.locked) throw new ApiError(409, 'maintenance', '已有恢复任务正在运行。');
    this.locked = true;
    try {
      if (this.active) await new Promise<void>(resolve => this.waiting.push(resolve));
      return await run();
    } finally { this.locked = false; }
  }
}
