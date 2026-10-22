import { getPruneBefore, withRetentionSetting } from 'src/utils/sync-retention.js';

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2027-06-01T00:00:00.000Z');
const daysAgo = (days: number) => new Date(now.getTime() - days * DAY);

describe('sync delete retention', () => {
  it('should record the upstream retention as the one before the first setting', () => {
    const state = withRetentionSetting(undefined, 365, daysAgo(100));
    expect(state.settings).toEqual([
      { days: 31, since: null, until: daysAgo(100).toISOString() },
      { days: 365, since: daysAgo(100).toISOString(), until: null },
    ]);
    // the same setting again changes nothing
    expect(withRetentionSetting(state, 365, now)).toBe(state);
  });

  it('should apply a longer retention to the deletions recorded before', () => {
    const state = withRetentionSetting(undefined, 365, daysAgo(100));
    expect(getPruneBefore(state, now)).toEqual(daysAgo(365));
  });

  it('should keep the deletions recorded under a longer retention for as long, after it is shortened', () => {
    let state = withRetentionSetting(undefined, 365, daysAgo(400));
    state = withRetentionSetting(state, 60, daysAgo(100));

    // what was recorded before the change, 100 days ago, stays for 365 days
    expect(getPruneBefore(state, now)).toEqual(daysAgo(365));
    // once those have expired, the shorter retention applies
    expect(getPruneBefore(state, new Date(now.getTime() + 300 * DAY))).toEqual(daysAgo(60 - 300));
  });

  it('should keep everything recorded while the records were kept forever', () => {
    let state = withRetentionSetting(undefined, null, daysAgo(200));
    expect(getPruneBefore(state, now)).toBeNull();

    state = withRetentionSetting(state, 30, daysAgo(100));
    // nothing recorded since the setting to keep them forever goes
    expect(getPruneBefore(state, now)).toEqual(daysAgo(200));
    expect(getPruneBefore(state, new Date(now.getTime() + 1000 * DAY))).toEqual(daysAgo(200));
  });

  it('should keep everything from when the records are kept forever', () => {
    const state = withRetentionSetting(withRetentionSetting(undefined, 365, daysAgo(400)), null, daysAgo(10));
    // the deletions of the earlier settings are kept forever too
    expect(getPruneBefore(state, now)).toBeNull();
  });
});
