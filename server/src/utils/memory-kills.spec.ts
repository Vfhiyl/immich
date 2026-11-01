import { addMemoryKill, countMemoryKills, isKilledProgram } from 'src/utils/memory-kills.js';

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 1) + minutes * 60_000);

describe('the times the background work ran out of memory', () => {
  it('should take kills within two minutes of each other as one time', () => {
    let state = addMemoryKill({ kills: [] }, 'a process', at(0));
    state = addMemoryKill(state, 'the background worker', at(1));
    state = addMemoryKill(state, 'a process', at(1.5), 2);
    state = addMemoryKill(state, 'a process', at(10));

    expect(state.kills).toEqual([
      { at: at(0).toISOString(), what: ['a process', 'the background worker'], count: 4 },
      { at: at(10).toISOString(), what: ['a process'], count: 1 },
    ]);
    expect(countMemoryKills(state, at(11))).toBe(2);
    expect(countMemoryKills(state, at(8 * 24 * 60))).toBe(0);
  });

  it('should keep 30 days', () => {
    const state = addMemoryKill(addMemoryKill({ kills: [] }, 'a process', at(0)), 'a process', at(31 * 24 * 60));
    expect(state.kills).toHaveLength(1);
  });

  it('should tell a program killed from one stopped as stuck', () => {
    expect(isKilledProgram(new Error('ffmpeg was killed with signal SIGKILL'))).toBe(true);
    expect(isKilledProgram(new Error('immich-thumbnail exited with SIGKILL: '))).toBe(true);
    expect(isKilledProgram(new Error('ffmpeg made no progress for 10 minutes and was stopped'))).toBe(false);
    expect(isKilledProgram(new Error('immich-thumbnail exited with 1: cannot open'))).toBe(false);
  });
});
