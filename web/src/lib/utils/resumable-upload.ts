import {
  AbortedError,
  MemorySessionStore,
  NetworkError,
  ResumableUploader,
  type ResumableUploadSession,
  type SessionStore,
  type Transport,
} from '@immich/sdk';

/** Sends with XMLHttpRequest, which tells the progress of a part */
export const xhrTransport: Transport = ({ method, url, headers, body, onProgress, signal }) =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    for (const [name, value] of Object.entries(headers)) {
      xhr.setRequestHeader(name, value);
    }
    if (onProgress) {
      xhr.upload.addEventListener('progress', (event) => onProgress(event.loaded));
    }
    const abort = () => xhr.abort();
    signal?.addEventListener('abort', abort);
    const done = () => signal?.removeEventListener('abort', abort);
    xhr.addEventListener('load', () => {
      done();
      resolve({ status: xhr.status, header: (name) => xhr.getResponseHeader(name), body: xhr.responseText });
    });
    xhr.addEventListener('error', () => {
      done();
      reject(new NetworkError(`${method} ${url} failed`));
    });
    xhr.addEventListener('timeout', () => {
      done();
      reject(new NetworkError(`${method} ${url} timed out`));
    });
    xhr.addEventListener('abort', () => {
      done();
      reject(new AbortedError('cancelled'));
    });
    xhr.send(body ?? null);
  });

/** Keeps uploads in progress across reloads of the page; in memory where the browser has no IndexedDB for the page */
export class IndexedDbSessionStore implements SessionStore {
  #db?: Promise<IDBDatabase | undefined>;
  readonly #fallback = new MemorySessionStore();

  #open() {
    this.#db ??= new Promise((resolve) => {
      try {
        const request = indexedDB.open('immich-resumable-uploads', 1);
        request.addEventListener('upgradeneeded', () => request.result.createObjectStore('sessions'));
        request.addEventListener('success', () => resolve(request.result));
        request.addEventListener('error', () => resolve(undefined));
      } catch {
        resolve(undefined);
      }
    });
    return this.#db;
  }

  async #run<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest, fallback: () => Promise<T>) {
    const db = await this.#open();
    if (!db) {
      return fallback();
    }
    return new Promise<T>((resolve) => {
      try {
        const request = run(db.transaction('sessions', mode).objectStore('sessions'));
        request.addEventListener('success', () => resolve(request.result as T));
        request.addEventListener('error', () => resolve(undefined as T));
      } catch {
        resolve(undefined as T);
      }
    });
  }

  get(key: string) {
    return this.#run<ResumableUploadSession | undefined>(
      'readonly',
      (store) => store.get(key),
      () => this.#fallback.get(key),
    );
  }

  async put(key: string, session: ResumableUploadSession) {
    await this.#run(
      'readwrite',
      (store) => store.put(session, key),
      () => this.#fallback.put(key, session),
    );
  }

  async remove(key: string) {
    await this.#run(
      'readwrite',
      (store) => store.delete(key),
      () => this.#fallback.remove(key),
    );
  }
}

export const resumableUploader = new ResumableUploader(xhrTransport, new IndexedDbSessionStore());
