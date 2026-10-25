import { OutputTail } from 'src/utils/output-tail.js';

describe(OutputTail.name, () => {
  it('should keep what was written, up to its length', () => {
    const tail = new OutputTail(10);
    tail.push('abc');
    tail.push(Buffer.from('def'));
    expect(tail.toString()).toBe('abcdef');
  });

  it('should keep only the end of a long output', () => {
    const tail = new OutputTail(10);
    for (let index = 0; index < 1000; index++) {
      tail.push(`line ${index}\n`);
    }
    expect(tail.toString()).toBe('\nline 999\n');
  });
});
