import {
  defaults,
  fetchTransport,
  ResumableUploader,
  type ResumableUploadSession,
  type SessionStore,
  type Transport,
} from '@immich/sdk';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Uploads in progress, in a file of the config directory: an upload stopped by a broken connection or the command
 * being stopped goes on where it stopped when the command runs again. Written whole (to a new file, renamed over the
 * old), one change at a time.
 */
export class FileSessionStore implements SessionStore {
  #sessions?: Promise<Record<string, ResumableUploadSession>>;
  #writing: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async #read(): Promise<Record<string, ResumableUploadSession>> {
    try {
      const sessions = JSON.parse(await readFile(this.path, 'utf8')) as unknown;
      return sessions && typeof sessions === 'object' ? (sessions as Record<string, ResumableUploadSession>) : {};
    } catch {
      return {};
    }
  }

  async #write(sessions: Record<string, ResumableUploadSession>) {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(sessions), { mode: 0o600 });
    await rename(temporary, this.path);
  }

  async #change(change: (sessions: Record<string, ResumableUploadSession>) => void) {
    this.#sessions ??= this.#read();
    const sessions = await this.#sessions;
    change(sessions);
    const previous = this.#writing;
    const write = (async () => {
      await previous;
      await this.#write(sessions);
    })();
    this.#writing = (async () => {
      try {
        await write;
      } catch {
        // the next change writes everything again
      }
    })();
    await write;
  }

  async get(key: string) {
    this.#sessions ??= this.#read();
    const sessions = await this.#sessions;
    return sessions[key];
  }

  put(key: string, session: ResumableUploadSession) {
    return this.#change((sessions) => {
      sessions[key] = session;
    });
  }

  remove(key: string) {
    return this.#change((sessions) => {
      delete sessions[key];
    });
  }
}

/** With the key of the CLI, as its other requests */
const authenticatedTransport: Transport = (request) =>
  fetchTransport({ ...request, headers: { ...(defaults.headers as Record<string, string>), ...request.headers } });

export const getSessionsPath = (configDirectory: string) => join(configDirectory, 'uploads.json');

export const createUploader = (configDirectory: string) =>
  new ResumableUploader(authenticatedTransport, new FileSessionStore(getSessionsPath(configDirectory)));
