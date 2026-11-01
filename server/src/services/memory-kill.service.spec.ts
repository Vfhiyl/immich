import { NotificationLevel, SystemMetadataKey } from 'src/enum.js';
import { MemoryKillService } from 'src/services/memory-kill.service.js';
import { MemoryKillState } from 'src/utils/memory-kills.js';
import { UserFactory } from 'test/factories/user.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const oomKills = vi.hoisted(() => ({ count: null as number | null }));
vitest.mock('src/utils/server-resources.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('src/utils/server-resources.js')>()),
  readOomKills: () => Promise.resolve(oomKills.count),
}));

describe(MemoryKillService.name, () => {
  let sut: MemoryKillService;
  let mocks: ServiceMocks;
  let state: MemoryKillState | null;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(MemoryKillService));
    state = null;
    oomKills.count = null;
    mocks.systemMetadata.get.mockImplementation(() => Promise.resolve(state));
    mocks.systemMetadata.set.mockImplementation((_, value) => {
      state = value as MemoryKillState;
      return Promise.resolve();
    });
    mocks.user.getAdmin.mockResolvedValue(UserFactory.create({ isAdmin: true }));
    mocks.notification.create.mockResolvedValue({ id: 'n', createdAt: new Date() } as never);
  });

  it('should count the processes the kernel killed for memory since it last looked, and tell the admin once a day', async () => {
    oomKills.count = 5;
    await sut.check();
    // the count when it first looked: nothing new
    expect(state).toEqual({ kills: [], oomKills: 5 });
    expect(mocks.notification.create).not.toHaveBeenCalled();

    oomKills.count = 7;
    await sut.check();
    expect(state!.kills).toEqual([{ at: expect.any(String), what: ['a process'], count: 2 }]);
    expect(state!.oomKills).toBe(7);
    expect(mocks.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({ level: NotificationLevel.Warning, title: 'The server ran out of memory' }),
    );

    // once more the same day: counted, not told again
    oomKills.count = 8;
    await sut.check();
    expect(mocks.notification.create).toHaveBeenCalledOnce();
    expect(mocks.systemMetadata.set).toHaveBeenLastCalledWith(SystemMetadataKey.MemoryKills, expect.any(Object));
  });

  it('should count a job whose program was killed, but not one stopped as stuck', async () => {
    const job = { name: 'AssetGenerateThumbnails' } as never;
    await sut.onJobError({ job, error: new Error('immich-thumbnail exited with SIGKILL: ') });
    await sut.onJobError({
      job,
      error: new Error('immich-thumbnail made no progress for 10 minutes and was stopped'),
    });

    expect(state!.kills).toEqual([
      { at: expect.any(String), what: ['a program of AssetGenerateThumbnails'], count: 1 },
    ]);
  });

  it('should count the background worker the kernel killed, as the supervisor tells it', async () => {
    process.env.IMMICH_WORKER_LAST_EXIT = 'SIGKILL';
    try {
      await sut.onBootstrap();
    } finally {
      sut.onShutdown();
      delete process.env.IMMICH_WORKER_LAST_EXIT;
    }

    expect(state!.kills).toEqual([{ at: expect.any(String), what: ['the background worker'], count: 1 }]);
  });
});
