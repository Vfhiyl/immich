import { parseRange } from 'src/utils/file.js';

describe(parseRange.name, () => {
  it.each([
    ['no header', undefined, null],
    ['a whole range', 'bytes=0-99', { start: 0, end: 99 }],
    ['an open range', 'bytes=100-', { start: 100, end: 999 }],
    ['a suffix range', 'bytes=-100', { start: 900, end: 999 }],
    ['a suffix longer than the blob', 'bytes=-5000', { start: 0, end: 999 }],
    ['an end past the last byte', 'bytes=990-5000', { start: 990, end: 999 }],
    ['several ranges, which may be answered with the whole blob', 'bytes=0-1,5-6', null],
    ['another unit', 'items=0-1', null],
    ['no bounds at all', 'bytes=-', null],
  ])('should handle %s', (_, header, expected) => {
    expect(parseRange(header, 1000)).toEqual(expected);
  });

  it.each([
    ['a start past the last byte', 'bytes=1000-'],
    ['an end before the start', 'bytes=10-5'],
    ['an empty suffix', 'bytes=-0'],
  ])('should reject %s', (_, header) => {
    expect(parseRange(header, 1000)).toBe('unsatisfiable');
  });

  it('should reject any range of an empty blob', () => {
    expect(parseRange('bytes=-1', 0)).toBe('unsatisfiable');
    expect(parseRange('bytes=0-', 0)).toBe('unsatisfiable');
  });
});
