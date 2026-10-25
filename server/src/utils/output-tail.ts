/** How much of what a program writes to stderr is kept for its error message */
export const OUTPUT_TAIL_LENGTH = 16 * 1024;

/**
 * The end of what a program wrote, for an error message: a program may go on writing (a warning for each frame of a
 * long video, say), and keeping all of it would take ever more memory
 */
export class OutputTail {
  private text = '';

  constructor(private readonly length = OUTPUT_TAIL_LENGTH) {}

  push(chunk: string | Buffer) {
    this.text = (this.text + chunk.toString()).slice(-this.length);
  }

  toString() {
    return this.text;
  }
}
