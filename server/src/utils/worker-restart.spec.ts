import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import {
  BACKGROUND_OOM_SCORE_ADJ,
  exitWithSupervisor,
  getWorkerRestartDelay,
  preferAsOomVictim,
} from 'src/utils/worker-restart.js';

vi.mock('node:fs', () => ({ writeFileSync: vi.fn() }));

describe('restarting a background worker', () => {
  it('should wait longer after each crash in a row, up to a minute', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((crashes) => getWorkerRestartDelay(crashes))).toEqual([
      1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000,
    ]);
    expect(getWorkerRestartDelay(0)).toBe(1000);
  });

  it('should raise its own oom score', () => {
    expect(preferAsOomVictim()).toBe(true);
    expect(writeFileSync).toHaveBeenCalledWith('/proc/self/oom_score_adj', String(BACKGROUND_OOM_SCORE_ADJ));
  });

  it('should go on where the oom score cannot be changed', () => {
    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw new Error('EACCES');
    });
    expect(preferAsOomVictim()).toBe(false);
  });

  it('should end a forked worker when its supervisor is gone', () => {
    const forked = Object.assign(new EventEmitter(), { channel: {} });
    const exit = vi.fn();

    expect(exitWithSupervisor(forked, exit)).toBe(true);
    expect(exit).not.toHaveBeenCalled();
    forked.emit('disconnect');
    expect(exit).toHaveBeenCalledOnce();
  });

  it('should watch nothing in a process that was not forked', () => {
    const alone = Object.assign(new EventEmitter(), { channel: undefined });
    const exit = vi.fn();

    expect(exitWithSupervisor(alone, exit)).toBe(false);
    alone.emit('disconnect');
    expect(exit).not.toHaveBeenCalled();
  });
});
