import { spawn } from 'node:child_process';
import { readProcessIo, watchProgress } from 'src/utils/progress-watchdog.js';

// a program whose reads and writes the test sets
const program = () => {
  const state = { io: 0 as number | null };
  return { state, readIo: () => Promise.resolve(state.io) };
};
const options = (readIo: () => Promise<number | null>) => ({ stallMs: 600_000, checkMs: 30_000, readIo });

describe(watchProgress.name, () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('should let a slow program go on while it reads or writes', async () => {
    const { state, readIo } = program();
    const onStall = vi.fn();
    const watch = watchProgress(1, onStall, options(readIo));

    // an hour, a few bytes every 5 minutes
    for (let minute = 0; minute < 60; minute += 5) {
      state.io = (state.io ?? 0) + 10;
      await vi.advanceTimersByTimeAsync(300_000);
    }

    expect(onStall).not.toHaveBeenCalled();
    watch.stop();
  });

  it('should take a program that does nothing for 10 minutes as stuck, once', async () => {
    const { readIo } = program();
    const onStall = vi.fn();
    watchProgress(1, onStall, options(readIo));

    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(onStall).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(onStall).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(onStall).toHaveBeenCalledOnce();
  });

  it('should count what the program reports as progress', async () => {
    const { readIo } = program();
    const onStall = vi.fn();
    const watch = watchProgress(1, onStall, options(readIo));

    for (let minute = 0; minute < 30; minute += 5) {
      watch.beat();
      await vi.advanceTimersByTimeAsync(300_000);
    }

    expect(onStall).not.toHaveBeenCalled();
    watch.stop();
  });

  it('should not stop a program it cannot watch', async () => {
    const onStall = vi.fn();
    watchProgress(
      1,
      onStall,
      options(() => Promise.resolve(null)),
    );

    await vi.advanceTimersByTimeAsync(60 * 60_000);

    expect(onStall).not.toHaveBeenCalled();
  });
});

describe(readProcessIo.name, () => {
  it('should read what a program read and wrote', async () => {
    // a program that waits for input
    const child = spawn('cat', [], { stdio: ['pipe', 'pipe', 'ignore'] });
    const before = await readProcessIo(child.pid!);
    child.stdin.write('x'.repeat(10_000));
    await new Promise((resolve) => child.stdout.once('data', resolve));
    const after = await readProcessIo(child.pid!);
    child.kill();

    expect(before).not.toBeNull();
    expect(after!).toBeGreaterThan(before!);
  });
});
