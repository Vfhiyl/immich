import { authManager } from '#lib/managers/auth-manager.svelte.ts';
import { uploadManager } from '#lib/managers/upload-manager.svelte.ts';
import { uploadAssetsStore } from '#lib/stores/upload.ts';
import { UploadState } from '#lib/types.ts';
import { uploadRequest } from '#lib/utils.ts';
import { factory } from '#test/unit/factories.ts';
import { test } from '#test/unit/fixtures.ts';
import {
  AssetMediaStatus,
  UploadInterruptedError,
  type AssetMediaResponseDto,
  type UserAdminResponseDto,
} from '@immich/sdk';
import { get } from 'svelte/store';
import { beforeEach, describe, expect, vi } from 'vitest';
import { fileUploadHandler } from './file-uploader';
import { resumableUploader } from './resumable-upload';

vi.mock('#lib/utils.ts', { spy: true });

describe('fileUploader error handling', () => {
  const newFile = () => new File(['content'], `${crypto.randomUUID()}.jpg`, { type: 'image/jpeg' });
  const mockUserObject = factory.user();
  const mockError = new Error('Upload failed');
  const mockUploadResponse = { id: 'mock-id', status: AssetMediaStatus.Created } as AssetMediaResponseDto;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(uploadManager, 'getExtensions').mockReturnValue(['.jpg']);
    // a server without uploads in parts
    vi.spyOn(resumableUploader, 'getOptions').mockResolvedValue(undefined);
    uploadAssetsStore.reset();
    authManager.reset();
  });

  for (const [name, mockUser] of [
    ['logged-in users', true],
    ['anonymous users', false],
  ] as const) {
    describe(`for ${name}`, () => {
      beforeEach(() => {
        if (mockUser) {
          authManager.setUser(mockUserObject);
        }
      });

      test(`should transition successful uploads to done`, async () => {
        vi.mocked(uploadRequest).mockResolvedValue({ status: 200, data: mockUploadResponse });

        await fileUploadHandler({ files: [newFile()] });

        const items = get(uploadAssetsStore);
        expect(items.length).toBe(1);
        expect(items[0].state).toBe(UploadState.DONE);
      });

      test('should capture errors', async ({ logger }) => {
        vi.mocked(uploadRequest).mockRejectedValue(mockError);

        await fileUploadHandler({ files: [newFile()] });

        const items = get(uploadAssetsStore);
        expect(items.length).toBe(1);
        expect(items[0].state).toBe(UploadState.ERROR);
        expect(logger.error).toHaveBeenCalledWith(/Upload failed/);
      });
    });
  }

  test('should suppress errors on logout', async () => {
    authManager.setUser(mockUserObject);
    authManager.setPreferences(factory.preferences());
    vi.mocked(uploadRequest).mockImplementationOnce(() => {
      authManager.reset();
      return Promise.reject(mockError);
    });

    await fileUploadHandler({ files: [newFile()] });

    const items = get(uploadAssetsStore);
    expect(items.length).toBe(1);
    expect(items[0].state).toBe(UploadState.STARTED);
  });
});

describe('fileUploader in parts', () => {
  const mockFile = new File(['content'], 'test.jpg', { type: 'image/jpeg', lastModified: 1_700_000_000_000 });
  const mockUserObject = { id: 'user-123', email: 'test@example.com' } as UserAdminResponseDto;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(uploadManager, 'getExtensions').mockReturnValue(['.jpg']);
    uploadAssetsStore.reset();
    authManager.reset();
    authManager.setUser(mockUserObject);
    // hashing runs in a worker
    vi.stubGlobal(
      'Worker',
      class extends EventTarget {
        postMessage() {
          this.dispatchEvent(
            new MessageEvent('message', { data: { result: 'a9993e364706816aba3e25717850c26c9cd0d89d' } }),
          );
        }
        terminate() {}
      },
    );
    vi.mocked(uploadRequest).mockRejectedValue(new Error('not in parts'));
  });

  test('uploads in parts when the server takes them, so that the same file selected again goes on', async () => {
    vi.spyOn(resumableUploader, 'getOptions').mockResolvedValue({ maxAppendSize: 1000 });
    const upload = vi.spyOn(resumableUploader, 'upload').mockResolvedValue({ id: 'asset-1', status: 'created' });

    await fileUploadHandler({ files: [mockFile] });

    expect(get(uploadAssetsStore)[0].state).toBe(UploadState.DONE);
    expect(upload).toHaveBeenCalledWith(
      expect.objectContaining({
        checksum: 'a9993e364706816aba3e25717850c26c9cd0d89d',
        sessionKey: `user-123:test.jpg:${mockFile.size}:1700000000000`,
        assetData: expect.objectContaining({ filename: 'test.jpg', isFavorite: false }),
      }),
    );
    expect(uploadRequest).not.toHaveBeenCalled();
  });

  test('tells that the upload of an interrupted file goes on when it is uploaded again', async () => {
    vi.spyOn(resumableUploader, 'getOptions').mockResolvedValue({ maxAppendSize: 1000 });
    vi.spyOn(resumableUploader, 'upload').mockRejectedValue(new UploadInterruptedError('cut'));

    await fileUploadHandler({ files: [mockFile] });

    const [item] = get(uploadAssetsStore);
    expect(item.state).toBe(UploadState.ERROR);
    expect(item.error).toContain('upload_interrupted_can_resume');
  });

  test('uploads the whole file to a server without uploads in parts', async () => {
    vi.spyOn(resumableUploader, 'getOptions').mockResolvedValue(undefined);
    vi.mocked(uploadRequest).mockResolvedValue({
      status: 200,
      data: { id: 'asset-1', status: AssetMediaStatus.Created },
    });

    await fileUploadHandler({ files: [mockFile] });

    expect(get(uploadAssetsStore)[0].state).toBe(UploadState.DONE);
    expect(uploadRequest).toHaveBeenCalled();
  });
});
