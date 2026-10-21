import { join } from 'node:path';
import { StorageCore } from 'src/cores/storage.core.js';
import { SystemConfig } from 'src/dtos/config.dto.js';
import { StorageBackendRole, StorageFolder } from 'src/enum.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { StorageBackendRepository, StoredFile } from 'src/repositories/storage-backend.repository.js';

type Repos = {
  media: MediaRepository;
  crypto: CryptoRepository;
  storageCore: StorageCore;
  storageBackend: StorageBackendRepository;
};

/** Generate a profile image and store it; returns its (logical) path and where it is stored */
export const generateProfileImage = async (
  { media, crypto, storageCore, storageBackend }: Repos,
  { image }: SystemConfig,
  userId: string,
  input: string | Buffer,
): Promise<{ path: string; file: StoredFile }> => {
  const outputPath = join(
    StorageCore.getFolderLocation(StorageFolder.Profile, userId),
    `${crypto.randomUUID()}.${image.thumbnail.format}`,
  );
  storageCore.ensureFolders(outputPath);
  await using output = await storageBackend.createOutput(StorageBackendRole.Derived, outputPath);

  const decoded = await media.decodeImage(input, { colorspace: image.colorspace, processInvalidImages: false });
  await media.generateThumbnail(
    decoded,
    {
      colorspace: image.colorspace,
      format: image.thumbnail.format,
      quality: image.thumbnail.quality,
      progressive: image.thumbnail.progressive,
      size: image.thumbnail.size,
      processInvalidImages: false,
    },
    output.path,
  );

  return { path: outputPath, file: await output.commit() };
};
