import { Injectable } from '@nestjs/common';
import type {
  AudioStreamInfo,
  DecodeToBufferOptions,
  GenerateThumbnailOptions,
  ImageDimensions,
  JobItem,
  JobOf,
  VideoFormat,
  VideoInterfaces,
  VideoStreamInfo,
} from 'src/types.js';
import { FACE_THUMBNAIL_SIZE } from 'src/constants.js';
import { ImagePathOptions, StorageCore, ThumbnailPathEntity } from 'src/cores/storage.core.js';
import { AssetFile } from 'src/database.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import { ConfigFFmpegDto, SystemConfig } from 'src/dtos/config.dto.js';
import { AssetEditAction, CropParameters } from 'src/dtos/editing.dto.js';
import {
  AssetFileType,
  AssetType,
  AssetVisibility,
  AudioCodec,
  Colorspace,
  ImageFormat,
  ImmichWorker,
  JobName,
  JobStatus,
  QueueName,
  RawExtractedFormat,
  StorageBackendRole,
  StorageFolder,
  SystemMetadataKey,
  TranscodeHardwareAcceleration,
  TranscodePolicy,
  TranscodeTarget,
  VideoCodec,
  VideoContainer,
} from 'src/enum.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { BoundingBox } from 'src/repositories/machine-learning.repository.js';
import {
  OutputFile,
  StoredFile,
  isSameStoredFile,
  toFileDeletion,
  toRecordedFile,
} from 'src/repositories/storage-backend.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { getAssetFile, getDimensions } from 'src/utils/asset.util.js';
import { DERIVED_MAX_RATIO, DERIVED_SIZE_RULE_VERSION } from 'src/utils/derived-size.js';
import { checkFaceVisibility, checkOcrVisibility } from 'src/utils/editor.js';
import { BaseConfig, ThumbnailConfig } from 'src/utils/media.js';
import { mimeTypes } from 'src/utils/mime-types.js';
import { batched, clamp } from 'src/utils/misc.js';
import { getOutputDimensions } from 'src/utils/transform.js';

interface UpsertFileOptions {
  assetId: string;
  type: AssetFileType;
  path: string;
  isEdited: boolean;
  isProgressive: boolean;
  isTransparent: boolean;
}

/** A generated file, stored at its path or on the backend for derived files */
type GeneratedFile = UpsertFileOptions & StoredFile;

type ThumbnailAsset = NonNullable<Awaited<ReturnType<AssetJobRepository['getForGenerateThumbnailJob']>>>;
type VideoConversionAsset = NonNullable<Awaited<ReturnType<AssetJobRepository['getForVideoConversion']>>>;

@Injectable()
export class MediaService extends BaseService {
  videoInterfaces: VideoInterfaces = { dri: [], mali: false };

  @OnEvent({ name: 'AppBootstrap', workers: [ImmichWorker.Microservices] })
  async onBootstrap() {
    this.videoInterfaces = await this.storageCore.getVideoInterfaces();
  }

  /**
   * The previews and thumbnails of images longer than 4096:1440 were made by their short side alone (a long screenshot
   * of 1080 x 20000 had a preview of its own size); they are made again by the rule of getDerivedScale, once
   */
  @OnEvent({ name: 'AppBootstrap', workers: [ImmichWorker.Microservices] })
  async onDerivedSizeRule() {
    const state = await this.systemMetadataRepository.get(SystemMetadataKey.DerivedSizeRule);
    if ((state?.version ?? 0) >= DERIVED_SIZE_RULE_VERSION) {
      return;
    }

    let count = 0;
    for await (const assets of batched(this.assetJobRepository.streamLongImages(DERIVED_MAX_RATIO))) {
      await this.jobRepository.queueAll(
        assets.map(({ id }) => ({ name: JobName.AssetGenerateThumbnails, data: { id } })),
      );
      count += assets.length;
    }
    await this.systemMetadataRepository.set(SystemMetadataKey.DerivedSizeRule, { version: DERIVED_SIZE_RULE_VERSION });
    if (count > 0) {
      this.logger.log(`Making the previews and thumbnails of ${count} long images again`);
    }
  }

  @OnJob({ name: JobName.AssetGenerateThumbnailsQueueAll, queue: QueueName.ThumbnailGeneration })
  async handleQueueGenerateThumbnails({ force }: JobOf<JobName.AssetGenerateThumbnailsQueueAll>): Promise<JobStatus> {
    const config = await this.getConfig({ withCache: true });

    const isFullsizeEnabled = config.image.fullsize.enabled;
    for await (const assets of batched(
      this.assetJobRepository.streamForThumbnailJob({ force, fullsizeEnabled: isFullsizeEnabled }),
    )) {
      const jobs: JobItem[] = [];
      for (const asset of assets) {
        if (force || !asset.isEdited) {
          jobs.push({ name: JobName.AssetGenerateThumbnails, data: { id: asset.id } });
        }

        if (asset.isEdited) {
          jobs.push({ name: JobName.AssetEditThumbnailGeneration, data: { id: asset.id } });
        }
      }

      await this.jobRepository.queueAll(jobs);
    }

    for await (const people of batched(this.personRepository.getAll(force ? undefined : { thumbnailPath: '' }))) {
      const jobs: JobItem[] = [];
      for (const person of people) {
        const { ownerId, personGroupId } = person;
        if (!person.faceAssetId) {
          const face = await this.personRepository.getRandomFace(personGroupId);
          if (!face) {
            continue;
          }

          await this.personRepository.update({ ownerId, personGroupId, faceAssetId: face.id });
        }

        jobs.push({ name: JobName.PersonGenerateThumbnail, data: { ownerId, personGroupId } });
      }

      await this.jobRepository.queueAll(jobs);
    }

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.FileMigrationQueueAll, queue: QueueName.Migration })
  async handleQueueMigration(): Promise<JobStatus> {
    const { active, waiting } = await this.jobRepository.getJobCounts(QueueName.Migration);
    if (active === 1 && waiting === 0) {
      await this.storageCore.removeEmptyDirs(StorageFolder.Thumbnails);
      await this.storageCore.removeEmptyDirs(StorageFolder.EncodedVideo);
    }

    for await (const assets of batched(this.assetJobRepository.streamForMigrationJob())) {
      await this.jobRepository.queueAll(
        assets.map((asset) => ({ name: JobName.AssetFileMigration, data: { id: asset.id } })),
      );
    }

    for await (const people of batched(this.personRepository.getAll())) {
      await this.jobRepository.queueAll(
        people.map(({ ownerId, personGroupId }) => ({
          name: JobName.PersonFileMigration,
          data: { ownerId, personGroupId },
        })),
      );
    }

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.AssetFileMigration, queue: QueueName.Migration })
  async handleAssetMigration({ id }: JobOf<JobName.AssetFileMigration>): Promise<JobStatus> {
    // files on a storage backend keep their key
    if (this.storageBackendRepository.getBackendFor(StorageBackendRole.Derived)) {
      return JobStatus.Skipped;
    }

    const { image } = await this.getConfig({ withCache: true });
    const asset = await this.assetJobRepository.getForMigrationJob(id);
    if (!asset) {
      return JobStatus.Failed;
    }

    await this.storageCore.moveAssetImage(asset, AssetFileType.FullSize, image.fullsize.format);
    await this.storageCore.moveAssetImage(asset, AssetFileType.Preview, image.preview.format);
    await this.storageCore.moveAssetImage(asset, AssetFileType.Thumbnail, image.thumbnail.format);
    await this.storageCore.moveAssetVideo(asset);

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.AssetEditThumbnailGeneration, queue: QueueName.Editor })
  async handleAssetEditThumbnailGeneration({ id }: JobOf<JobName.AssetEditThumbnailGeneration>): Promise<JobStatus> {
    const asset = await this.assetJobRepository.getForGenerateThumbnailJob(id);
    const config = await this.getConfig({ withCache: true });

    if (!asset) {
      this.logger.warn(`Thumbnail generation failed for asset ${id}: not found in database or missing metadata`);
      return JobStatus.Failed;
    }

    const generated = await this.generateEditedThumbnails(asset, config);
    await this.syncFiles(
      asset.files.filter((file) => file.isEdited),
      generated?.files ?? [],
    );

    let thumbhash: Buffer | undefined = generated?.thumbhash;
    if (!thumbhash) {
      const extractedImage = await this.extractOriginalImage(asset, config.image);
      const { info, data, colorspace } = extractedImage;

      thumbhash = await this.mediaRepository.generateThumbhash(
        { data, info },
        { colorspace, processInvalidImages: false, edits: [] },
      );
    }

    if (!asset.thumbhash || Buffer.compare(asset.thumbhash, thumbhash) !== 0) {
      await this.assetRepository.update({ id: asset.id, thumbhash });
    }

    const fullsizeDimensions = generated?.fullsizeDimensions ?? getDimensions(asset.exifInfo!);
    await this.assetRepository.update({ id: asset.id, ...fullsizeDimensions });

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.AssetGenerateThumbnails, queue: QueueName.ThumbnailGeneration })
  async handleGenerateThumbnails({ id }: JobOf<JobName.AssetGenerateThumbnails>): Promise<JobStatus> {
    const asset = await this.assetJobRepository.getForGenerateThumbnailJob(id);
    const config = await this.getConfig({ withCache: true });

    if (!asset) {
      this.logger.warn(`Thumbnail generation failed for asset ${id}: not found in database or missing metadata`);
      return JobStatus.Failed;
    }

    if (asset.visibility === AssetVisibility.Hidden) {
      this.logger.verbose(`Thumbnail generation skipped for asset ${id}: not visible`);
      return JobStatus.Skipped;
    }

    const isVideo = asset.type === AssetType.Video || asset.originalFileName.toLowerCase().endsWith('.gif');
    if (!isVideo && asset.type !== AssetType.Image) {
      this.logger.warn(`Skipping thumbnail generation for asset ${id}: ${asset.type} is not an image or video`);
      return JobStatus.Skipped;
    }

    try {
      return await this.generateThumbnails(asset, isVideo, config);
    } finally {
      // the last step that reads the original of an image; videos are transcoded next
      if (asset.type !== AssetType.Video) {
        await this.storageBackendRepository.dropLocalCopy(asset.originalFile);
      }
    }
  }

  private async generateThumbnails(asset: ThumbnailAsset, isVideo: boolean, config: SystemConfig): Promise<JobStatus> {
    // read the original once from a local file, wherever it is stored
    await using original = await this.storageBackendRepository.lease(
      toRecordedFile(asset.originalPath, asset.originalFile),
    );
    const source = { ...asset, originalPath: original.path };

    let generated: Awaited<ReturnType<MediaService['generateImageThumbnails']>>;
    if (isVideo) {
      this.logger.verbose(`Thumbnail generation for video ${asset.id} ${asset.originalPath}`);
      generated = await this.generateVideoThumbnails(source, config);
    } else {
      this.logger.verbose(`Thumbnail generation for image ${asset.id} ${asset.originalPath}`);
      generated = await this.generateImageThumbnails(source, config);
    }

    const editedGenerated = await this.generateEditedThumbnails(source, config);
    if (editedGenerated) {
      generated.files.push(...editedGenerated.files);
    }

    await this.syncFiles(asset.files, generated.files);
    const thumbhash = editedGenerated?.thumbhash || generated.thumbhash;

    if (!asset.thumbhash || Buffer.compare(asset.thumbhash, thumbhash) !== 0) {
      await this.assetRepository.update({ id: asset.id, thumbhash });
    }

    return JobStatus.Success;
  }

  private async extractImage(originalPath: string, minSize: number) {
    let extracted = await this.mediaRepository.extract(originalPath);
    if (extracted && !(await this.shouldUseExtractedImage(extracted.buffer, minSize))) {
      extracted = null;
    }

    return extracted;
  }

  private async decodeImage(thumbSource: string | Buffer, exifInfo: ThumbnailAsset['exifInfo'], targetSize?: number) {
    const { image } = await this.getConfig({ withCache: true });
    const colorspace = this.isSRGB(exifInfo) ? Colorspace.Srgb : image.colorspace;
    const decodeOptions: DecodeToBufferOptions = {
      colorspace,
      processInvalidImages: process.env.IMMICH_PROCESS_INVALID_IMAGES === 'true',
      size: targetSize,
      orientation: exifInfo.orientation ? Number(exifInfo.orientation) : undefined,
    };

    const { info, data } = await this.mediaRepository.decodeImage(thumbSource, decodeOptions);
    return { info, data, colorspace };
  }

  private async extractOriginalImage(asset: ThumbnailAsset, image: SystemConfig['image'], useEdits = false) {
    const isExtractEmbedded = image.extractEmbedded && mimeTypes.isRaw(asset.originalFileName);
    const extracted = isExtractEmbedded ? await this.extractImage(asset.originalPath, image.preview.size) : null;
    const isGenerateFullsize =
      ((image.fullsize.enabled || asset.exifInfo.projectionType === 'EQUIRECTANGULAR') &&
        !mimeTypes.isWebSupportedImage(asset.originalPath)) ||
      useEdits;
    const isConvertFullsize =
      isGenerateFullsize && (!extracted || !mimeTypes.isWebSupportedImage(` .${extracted.format}`));

    const thumbSource = extracted ? extracted.buffer : asset.originalPath;
    const { data, info, colorspace } = await this.decodeImage(
      thumbSource,
      // only specify orientation to extracted images which don't have EXIF orientation data
      // or it can double rotate the image
      extracted ? asset.exifInfo : { ...asset.exifInfo, orientation: null },
      isConvertFullsize ? undefined : image.preview.size,
    );

    let isTransparent = false;
    if (!extracted && mimeTypes.canBeTransparent(asset.originalPath)) {
      ({ isTransparent } = await this.mediaRepository.getImageMetadata(asset.originalPath));
    }

    return {
      extracted,
      data,
      info,
      colorspace,
      convertFullsize: isConvertFullsize,
      generateFullsize: isGenerateFullsize,
      isTransparent,
    };
  }

  private async generateImageThumbnails(asset: ThumbnailAsset, { image }: SystemConfig, useEdits: boolean = false) {
    // Handle embedded preview extraction for RAW files
    const extractedImage = await this.extractOriginalImage(asset, image, useEdits);
    const { info, data, colorspace, generateFullsize, convertFullsize, extracted, isTransparent } = extractedImage;

    const previewFormat = image.preview.format;
    this.warnOnTransparencyLoss(isTransparent, previewFormat, asset.id);

    const thumbnailFormat = image.thumbnail.format;
    this.warnOnTransparencyLoss(isTransparent, thumbnailFormat, asset.id);

    const previewFile = this.getImageFile(asset, {
      fileType: AssetFileType.Preview,
      format: previewFormat,
      isEdited: useEdits,
      isProgressive: !!image.preview.progressive && previewFormat !== ImageFormat.Webp,
      isTransparent,
    });
    const thumbnailFile = this.getImageFile(asset, {
      fileType: AssetFileType.Thumbnail,
      format: thumbnailFormat,
      isEdited: useEdits,
      isProgressive: !!image.thumbnail.progressive && thumbnailFormat !== ImageFormat.Webp,
      isTransparent,
    });
    this.storageCore.ensureFolders(previewFile.path);
    await using staged = new AsyncDisposableStack();
    const previewOutput = staged.use(await this.createDerivedOutput(previewFile.path));
    const thumbnailOutput = staged.use(await this.createDerivedOutput(thumbnailFile.path));

    // generate final images
    const decoded = { data, info };
    const baseOptions = { colorspace, processInvalidImages: false, edits: useEdits ? asset.edits : [] };
    const thumbnailOptions = { ...image.thumbnail, ...baseOptions, format: thumbnailFormat };
    const previewOptions = { ...image.preview, ...baseOptions, format: previewFormat };
    const promises = [
      this.mediaRepository.generateThumbhash(decoded, baseOptions),
      this.mediaRepository.generateThumbnail(decoded, thumbnailOptions, thumbnailOutput.path),
      this.mediaRepository.generateThumbnail(decoded, previewOptions, previewOutput.path),
    ];

    let fullsizeFile: UpsertFileOptions | undefined;
    let fullsizeOutput: OutputFile | undefined;
    if (convertFullsize) {
      const fullsizeFormat = image.fullsize.format;
      this.warnOnTransparencyLoss(isTransparent, fullsizeFormat, asset.id);
      // convert a new fullsize image from the same source as the thumbnail
      fullsizeFile = this.getImageFile(asset, {
        fileType: AssetFileType.FullSize,
        format: fullsizeFormat,
        isEdited: useEdits,
        isProgressive: !!image.fullsize.progressive && fullsizeFormat !== ImageFormat.Webp,
        isTransparent,
      });
      const fullsizeOptions = {
        ...baseOptions,
        format: fullsizeFormat,
        quality: image.fullsize.quality,
        progressive: image.fullsize.progressive,
      };
      fullsizeOutput = staged.use(await this.createDerivedOutput(fullsizeFile.path));
      promises.push(this.mediaRepository.generateThumbnail(decoded, fullsizeOptions, fullsizeOutput.path));
    } else if (generateFullsize && extracted && extracted.format === RawExtractedFormat.Jpeg) {
      fullsizeFile = this.getImageFile(asset, {
        fileType: AssetFileType.FullSize,
        format: extracted.format,
        isEdited: false,
        isProgressive: !!image.fullsize.progressive && image.fullsize.format !== ImageFormat.Webp,
        isTransparent,
      });
      this.storageCore.ensureFolders(fullsizeFile.path);
      fullsizeOutput = staged.use(await this.createDerivedOutput(fullsizeFile.path));

      // Write the buffer to disk with essential EXIF data
      await this.storageRepository.createOrOverwriteFile(fullsizeOutput.path, extracted.buffer);
      await this.mediaRepository.writeExif(
        {
          orientation: asset.exifInfo.orientation,
          colorspace: asset.exifInfo.colorspace,
        },
        fullsizeOutput.path,
      );
    }

    const outputs = await Promise.all(promises);

    if (asset.exifInfo.projectionType === 'EQUIRECTANGULAR') {
      const promises = [
        this.mediaRepository.copyTagGroup('XMP-GPano', asset.originalPath, previewOutput.path),
        fullsizeOutput
          ? this.mediaRepository.copyTagGroup('XMP-GPano', asset.originalPath, fullsizeOutput.path)
          : Promise.resolve(),
      ];
      await Promise.all(promises);
    }

    const decodedDimensions = { width: info.width, height: info.height };
    const fullsizeDimensions = useEdits ? getOutputDimensions(asset.edits, decodedDimensions) : decodedDimensions;

    // store the files only once they are complete
    const files: GeneratedFile[] = [
      { ...previewFile, ...(await previewOutput.commit()) },
      { ...thumbnailFile, ...(await thumbnailOutput.commit()) },
    ];
    if (fullsizeFile && fullsizeOutput) {
      files.push({ ...fullsizeFile, ...(await fullsizeOutput.commit()) });
    }

    return {
      files,
      thumbhash: outputs[0] as Buffer,
      fullsizeDimensions,
    };
  }

  @OnJob({ name: JobName.PersonGenerateThumbnail, queue: QueueName.ThumbnailGeneration })
  async handleGeneratePersonThumbnail({
    ownerId,
    personGroupId,
  }: JobOf<JobName.PersonGenerateThumbnail>): Promise<JobStatus> {
    const { image } = await this.getConfig({ withCache: true });
    const data = await this.personRepository.getDataForThumbnailGenerationJob({ ownerId, personGroupId });
    if (!data) {
      this.logger.error(`Could not generate person thumbnail for ${personGroupId}: missing data`);
      return JobStatus.Failed;
    }

    const { x1, y1, x2, y2, oldWidth, oldHeight, exifOrientation, previewFile, originalPath } = data;
    const isVideo = data.type === AssetType.Video;
    if (isVideo && !previewFile) {
      this.logger.error(`Could not generate person thumbnail for video ${personGroupId}: missing preview path`);
      return JobStatus.Failed;
    }

    // videos are cropped from their preview, images from their original
    await using source = await this.storageBackendRepository.lease(
      isVideo ? previewFile! : toRecordedFile(originalPath, data.originalFile),
    );
    let inputImage: string | Buffer;
    if (isVideo) {
      inputImage = source.path;
    } else if (image.extractEmbedded && mimeTypes.isRaw(originalPath)) {
      const extracted = await this.extractImage(source.path, image.preview.size);
      inputImage = extracted ? extracted.buffer : source.path;
    } else {
      inputImage = source.path;
    }

    const decoded = await this.mediaRepository.decodeImage(inputImage, {
      colorspace: image.colorspace,
      processInvalidImages: process.env.IMMICH_PROCESS_INVALID_IMAGES === 'true',
      // if this is an extracted image, it may not have orientation metadata
      orientation: Buffer.isBuffer(inputImage) && exifOrientation ? Number(exifOrientation) : undefined,
    });

    const thumbnailPath = StorageCore.getPersonThumbnailPath({ ownerId, personGroupId });
    this.storageCore.ensureFolders(thumbnailPath);
    await using thumbnail = await this.createDerivedOutput(thumbnailPath);

    const thumbnailOptions: GenerateThumbnailOptions = {
      colorspace: image.colorspace,
      format: ImageFormat.Jpeg,
      quality: image.thumbnail.quality,
      progressive: false,
      processInvalidImages: false,
      size: FACE_THUMBNAIL_SIZE,
      edits: [
        {
          action: AssetEditAction.Crop,
          parameters: this.getCrop(
            {
              old: { width: oldWidth, height: oldHeight },
              new: { width: decoded.info.width, height: decoded.info.height },
            },
            { x1, y1, x2, y2 },
          ),
        },
      ],
    };

    await this.mediaRepository.generateThumbnail(decoded, thumbnailOptions, thumbnail.path);
    const stored = await thumbnail.commit();
    const previous = await this.recordStoredFiles([stored], () =>
      this.personRepository.updateThumbnail({ ownerId, personGroupId, thumbnailPath, thumbnailFile: stored }),
    );
    if (previous && !isSameStoredFile(previous, { path: thumbnailPath, ...stored })) {
      await this.jobRepository.queue({ name: JobName.FileDelete, data: toFileDeletion([previous]) });
    }

    return JobStatus.Success;
  }

  private getCrop(
    dims: { old: ImageDimensions; new: ImageDimensions },
    { x1, y1, x2, y2 }: BoundingBox,
  ): CropParameters {
    // face bounding boxes can spill outside the image dimensions
    const clampedX1 = clamp(x1, 0, dims.old.width);
    const clampedY1 = clamp(y1, 0, dims.old.height);
    const clampedX2 = clamp(x2, 0, dims.old.width);
    const clampedY2 = clamp(y2, 0, dims.old.height);

    const widthScale = dims.new.width / dims.old.width;
    const heightScale = dims.new.height / dims.old.height;

    const halfWidth = (widthScale * (clampedX2 - clampedX1)) / 2;
    const halfHeight = (heightScale * (clampedY2 - clampedY1)) / 2;

    const middleX = Math.round(widthScale * clampedX1 + halfWidth);
    const middleY = Math.round(heightScale * clampedY1 + halfHeight);

    // zoom out 10%
    const targetHalfSize = Math.floor(Math.max(halfWidth, halfHeight) * 1.1);

    // get the longest distance from the center of the image without overflowing
    const newHalfSize = Math.min(
      middleX - Math.max(0, middleX - targetHalfSize),
      middleY - Math.max(0, middleY - targetHalfSize),
      Math.min(dims.new.width - 1, middleX + targetHalfSize) - middleX,
      Math.min(dims.new.height - 1, middleY + targetHalfSize) - middleY,
    );

    return {
      x: middleX - newHalfSize,
      y: middleY - newHalfSize,
      width: newHalfSize * 2,
      height: newHalfSize * 2,
    };
  }

  private async generateVideoThumbnails(asset: ThumbnailAsset, { ffmpeg, image }: SystemConfig) {
    const previewFile = this.getImageFile(asset, {
      fileType: AssetFileType.Preview,
      format: image.preview.format,
      isEdited: false,
      isProgressive: false,
      isTransparent: false,
    });
    const thumbnailFile = this.getImageFile(asset, {
      fileType: AssetFileType.Thumbnail,
      format: image.thumbnail.format,
      isEdited: false,
      isProgressive: false,
      isTransparent: false,
    });
    this.storageCore.ensureFolders(previewFile.path);

    const { videoStream, format } = asset;
    if (!videoStream || !format) {
      throw new Error(`Missing video metadata for asset ${asset.id}`);
    }

    const previewConfig = ThumbnailConfig.create({ ...ffmpeg, targetResolution: image.preview.size.toString() });
    const thumbConfig = ThumbnailConfig.create({ ...ffmpeg, targetResolution: image.thumbnail.size.toString() });
    const previewOptions = previewConfig.getCommand(TranscodeTarget.Video, videoStream, undefined, format ?? undefined);
    const thumbnailOptions = thumbConfig.getCommand(TranscodeTarget.Video, videoStream, undefined, format ?? undefined);

    await using previewOutput = await this.createDerivedOutput(previewFile.path);
    await using thumbnailOutput = await this.createDerivedOutput(thumbnailFile.path);
    await this.mediaRepository.transcode(asset.originalPath, previewOutput.path, previewOptions);
    await this.mediaRepository.transcode(asset.originalPath, thumbnailOutput.path, thumbnailOptions);

    const processInvalidImages = process.env.IMMICH_PROCESS_INVALID_IMAGES === 'true';
    const preview = await this.mediaRepository.decodeImage(previewOutput.path, {
      colorspace: image.colorspace,
      processInvalidImages,
    });
    const thumbhash = await this.mediaRepository.generateThumbhash(preview, {
      colorspace: image.colorspace,
      processInvalidImages,
    });

    return {
      files: [
        { ...previewFile, ...(await previewOutput.commit()) },
        { ...thumbnailFile, ...(await thumbnailOutput.commit()) },
      ],
      thumbhash,
      fullsizeDimensions: { width: videoStream.width, height: videoStream.height },
    };
  }

  @OnJob({ name: JobName.AssetEncodeVideoQueueAll, queue: QueueName.VideoConversion })
  async handleQueueVideoConversion(job: JobOf<JobName.AssetEncodeVideoQueueAll>): Promise<JobStatus> {
    const { force } = job;

    for await (const assets of batched(this.assetJobRepository.streamForVideoConversion(force))) {
      await this.jobRepository.queueAll(
        assets.map((asset) => ({ name: JobName.AssetEncodeVideo, data: { id: asset.id } })),
      );
    }

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.AssetEncodeVideo, queue: QueueName.VideoConversion })
  async handleVideoConversion({ id }: JobOf<JobName.AssetEncodeVideo>): Promise<JobStatus> {
    const asset = await this.assetJobRepository.getForVideoConversion(id);
    if (!asset) {
      return JobStatus.Failed;
    }

    try {
      return await this.convertVideo(asset);
    } finally {
      // the last step that reads the original of a video
      await this.storageBackendRepository.dropLocalCopy(asset.originalFile);
    }
  }

  private async convertVideo(asset: VideoConversionAsset): Promise<JobStatus> {
    const output = StorageCore.getEncodedVideoPath(asset);
    this.storageCore.ensureFolders(output);

    const { videoStream, format } = asset;
    const audioStream = asset.audioStream ?? undefined;
    if (!videoStream || !format) {
      this.logger.warn(`Skipped transcoding for asset ${asset.id}: missing metadata; re-run extraction first`);
      return JobStatus.Failed;
    }
    if (!videoStream.height || !videoStream.width) {
      this.logger.warn(`Skipped transcoding for asset ${asset.id}: no video dimensions`);
      return JobStatus.Failed;
    }

    let { ffmpeg } = await this.getConfig({ withCache: true });
    const target = this.getTranscodeTarget(ffmpeg, videoStream, audioStream);
    if (target === TranscodeTarget.None && !this.isRemuxRequired(ffmpeg, format)) {
      const encodedVideo = getAssetFile(asset.files, AssetFileType.EncodedVideo, { isEdited: false });
      if (encodedVideo) {
        this.logger.log(`Transcoded video exists for asset ${asset.id}, but is no longer required. Deleting...`);
        await this.jobRepository.queue({ name: JobName.FileDelete, data: toFileDeletion([encodedVideo]) });
        await this.assetRepository.deleteFiles([encodedVideo]);
      } else {
        this.logger.verbose(`Asset ${asset.id} does not require transcoding based on current policy, skipping`);
      }

      return JobStatus.Skipped;
    }

    // only fetch the original once it is certain to be transcoded
    await using original = await this.storageBackendRepository.lease(
      toRecordedFile(asset.originalPath, asset.originalFile),
    );
    const input = original.path;
    // read in ranges while it is played, and too large for the cache
    await using encoded = await this.createDerivedOutput(output, { cache: false });

    const command = BaseConfig.create(ffmpeg, this.videoInterfaces).getCommand(target, videoStream, audioStream);
    if (ffmpeg.accel === TranscodeHardwareAcceleration.Disabled) {
      this.logger.log(`Transcoding video ${asset.id} without hardware acceleration`);
    } else {
      this.logger.log(
        `Transcoding video ${asset.id} with ${ffmpeg.accel.toUpperCase()}-accelerated encoding and${ffmpeg.accelDecode ? '' : ' software'} decoding`,
      );
    }

    try {
      await this.mediaRepository.transcode(input, encoded.path, command);
    } catch (error: any) {
      this.logger.error(`Error occurred during transcoding: ${error.message}`);
      if (ffmpeg.accel === TranscodeHardwareAcceleration.Disabled) {
        return JobStatus.Failed;
      }

      let isPartialFallbackSuccess = false;
      if (ffmpeg.accelDecode) {
        try {
          this.logger.error(`Retrying with ${ffmpeg.accel.toUpperCase()}-accelerated encoding and software decoding`);
          ffmpeg = { ...ffmpeg, accelDecode: false };
          const command = BaseConfig.create(ffmpeg, this.videoInterfaces).getCommand(target, videoStream, audioStream);
          await this.mediaRepository.transcode(input, encoded.path, command);
          isPartialFallbackSuccess = true;
        } catch (error: any) {
          this.logger.error(`Error occurred during transcoding: ${error.message}`);
        }
      }

      if (!isPartialFallbackSuccess) {
        this.logger.error(`Retrying with ${ffmpeg.accel.toUpperCase()} acceleration disabled`);
        ffmpeg = { ...ffmpeg, accel: TranscodeHardwareAcceleration.Disabled };
        const command = BaseConfig.create(ffmpeg, this.videoInterfaces).getCommand(target, videoStream, audioStream);
        await this.mediaRepository.transcode(input, encoded.path, command);
      }
    }

    this.logger.log(`Successfully encoded ${asset.id}`);

    const stored = await encoded.commit();
    await this.recordStoredFiles([stored], () =>
      this.assetRepository.upsertFile({
        assetId: asset.id,
        type: AssetFileType.EncodedVideo,
        path: output,
        ...stored,
        isEdited: false,
      }),
    );

    // a video encoded again on a backend gets a new key, so the previous one is no longer used
    const previous = getAssetFile(asset.files, AssetFileType.EncodedVideo, { isEdited: false });
    if (previous && !isSameStoredFile(previous, { path: output, ...stored })) {
      await this.jobRepository.queue({ name: JobName.FileDelete, data: toFileDeletion([previous]) });
    }

    return JobStatus.Success;
  }

  private getTranscodeTarget(
    config: ConfigFFmpegDto,
    videoStream: VideoStreamInfo,
    audioStream?: AudioStreamInfo,
  ): TranscodeTarget {
    const isAudioTranscodeRequired = this.isAudioTranscodeRequired(config, audioStream);
    const isVideoTranscodeRequired = this.isVideoTranscodeRequired(config, videoStream);

    if (isAudioTranscodeRequired && isVideoTranscodeRequired) {
      return TranscodeTarget.All;
    }

    if (isAudioTranscodeRequired) {
      return TranscodeTarget.Audio;
    }

    if (isVideoTranscodeRequired) {
      return TranscodeTarget.Video;
    }

    return TranscodeTarget.None;
  }

  private isAudioTranscodeRequired(ffmpegConfig: ConfigFFmpegDto, stream?: AudioStreamInfo): boolean {
    if (!stream) {
      return false;
    }

    switch (ffmpegConfig.transcode) {
      case TranscodePolicy.Disabled: {
        return false;
      }
      case TranscodePolicy.All: {
        return true;
      }
      case TranscodePolicy.Required:
      case TranscodePolicy.Optimal:
      case TranscodePolicy.Bitrate: {
        return !ffmpegConfig.acceptedAudioCodecs.includes(stream.codecName as AudioCodec);
      }
      default: {
        throw new Error(`Unsupported transcode policy: ${ffmpegConfig.transcode}`);
      }
    }
  }

  private isVideoTranscodeRequired(ffmpegConfig: ConfigFFmpegDto, stream: VideoStreamInfo): boolean {
    const isScalingEnabled = ffmpegConfig.targetResolution !== 'original';
    const targetRes = Number.parseInt(ffmpegConfig.targetResolution);
    const isLargerThanTargetRes = isScalingEnabled && Math.min(stream.height, stream.width) > targetRes;
    const maxBitrate = this.parseBitrateToBps(ffmpegConfig.maxBitrate);
    const isLargerThanTargetBitrate = maxBitrate > 0 && stream.bitrate > maxBitrate;

    const isTargetVideoCodec = ffmpegConfig.acceptedVideoCodecs.includes(stream.codecName as VideoCodec);
    const isRequired = !isTargetVideoCodec || !stream.pixelFormat.endsWith('420p');

    switch (ffmpegConfig.transcode) {
      case TranscodePolicy.Disabled: {
        return false;
      }
      case TranscodePolicy.All: {
        return true;
      }
      case TranscodePolicy.Required: {
        return isRequired;
      }
      case TranscodePolicy.Optimal: {
        return isRequired || isLargerThanTargetRes;
      }
      case TranscodePolicy.Bitrate: {
        return isRequired || isLargerThanTargetBitrate;
      }
      default: {
        throw new Error(`Unsupported transcode policy: ${ffmpegConfig.transcode}`);
      }
    }
  }

  private isRemuxRequired(ffmpegConfig: ConfigFFmpegDto, { formatName, formatLongName }: VideoFormat): boolean {
    if (ffmpegConfig.transcode === TranscodePolicy.Disabled) {
      return false;
    }

    const formatLongNameMapping: Record<string, VideoContainer> = {
      'QuickTime / MOV': VideoContainer.Mov,
      'Matroska / WebM': VideoContainer.Webm,
    };

    const name = (formatLongName ? formatLongNameMapping[formatLongName] : undefined) ?? (formatName as VideoContainer);

    return name !== VideoContainer.Mp4 && !ffmpegConfig.acceptedContainers.includes(name);
  }

  isSRGB({
    colorspace,
    profileDescription,
    bitsPerSample,
  }: {
    colorspace: string | null;
    profileDescription: string | null;
    bitsPerSample: number | null;
  }): boolean {
    if (colorspace || profileDescription) {
      return [colorspace, profileDescription].some((s) => s?.toLowerCase().includes('srgb'));
    }
    if (bitsPerSample) {
      // assume sRGB for 8-bit images with no color profile or colorspace metadata
      return bitsPerSample === 8;
    }
    // assume sRGB for images with no relevant metadata
    return true;
  }

  private parseBitrateToBps(bitrateString: string) {
    const bitrateValue = Number.parseInt(bitrateString);

    if (Number.isNaN(bitrateValue)) {
      this.logger.log(`Maximum bitrate '${bitrateString} is not a number and will be ignored.`);
      return 0;
    }

    if (bitrateString.toLowerCase().endsWith('k')) {
      return bitrateValue * 1000; // Kilobits per second to bits per second
    }
    if (bitrateString.toLowerCase().endsWith('m')) {
      return bitrateValue * 1_000_000; // Megabits per second to bits per second
    }
    return bitrateValue;
  }

  private async shouldUseExtractedImage(extractedPathOrBuffer: string | Buffer, targetSize: number) {
    const { width, height } = await this.mediaRepository.getImageMetadata(extractedPathOrBuffer);
    const extractedSize = Math.min(width, height);
    return extractedSize >= targetSize;
  }

  private async syncFiles(
    oldFiles: (AssetFile & { isProgressive: boolean; isTransparent: boolean })[],
    newFiles: GeneratedFile[],
  ) {
    const toUpsert: GeneratedFile[] = [];
    const replaced: AssetFile[] = [];
    const toDelete = new Set(oldFiles);

    for (const newFile of newFiles) {
      const existingFile = oldFiles.find((file) => file.type === newFile.type && file.isEdited === newFile.isEdited);
      if (existingFile) {
        toDelete.delete(existingFile);
      }

      const isSameFile = existingFile !== undefined && isSameStoredFile(existingFile, newFile);

      // upsert new file path
      // eslint-disable-next-line unicorn/prefer-continue
      if (
        !isSameFile ||
        existingFile.path !== newFile.path ||
        existingFile.isProgressive !== newFile.isProgressive ||
        existingFile.isTransparent !== newFile.isTransparent
      ) {
        toUpsert.push(newFile);

        // delete old file from disk
        if (existingFile && !isSameFile) {
          this.logger.debug(
            `Deleting old ${newFile.type} image for asset ${newFile.assetId} in favor of a replacement`,
          );
          replaced.push(existingFile);
        }
      }
    }

    if (toUpsert.length > 0) {
      await this.recordStoredFiles(newFiles, () => this.assetRepository.upsertFiles(toUpsert));
    }

    if (toDelete.size > 0) {
      const toDeleteArray = [...toDelete];
      replaced.push(...toDeleteArray);
      await this.assetRepository.deleteFiles(toDeleteArray);
    }

    if (replaced.length > 0) {
      await this.jobRepository.queue({ name: JobName.FileDelete, data: toFileDeletion(replaced) });
    }
  }

  /** Thumbnails and previews are cached locally, since they are read right after (by ML jobs) and served often */
  private createDerivedOutput(path: string, { cache = true } = {}) {
    return this.storageBackendRepository.createOutput(StorageBackendRole.Derived, path, { cache });
  }

  private async generateEditedThumbnails(asset: ThumbnailAsset, config: SystemConfig) {
    if (asset.type !== AssetType.Image || (asset.files.length === 0 && asset.edits.length === 0)) {
      return;
    }

    const generated = asset.edits.length > 0 ? await this.generateImageThumbnails(asset, config, true) : undefined;

    const crop = asset.edits.find((e) => e.action === AssetEditAction.Crop);
    const cropBox = crop
      ? {
          x1: crop.parameters.x,
          y1: crop.parameters.y,
          x2: crop.parameters.x + crop.parameters.width,
          y2: crop.parameters.y + crop.parameters.height,
        }
      : undefined;

    const originalDimensions = getDimensions(asset.exifInfo!);
    const assetFaces = await this.personRepository.getFaces(asset.id, { viewingUserId: asset.ownerId });
    const ocrData = await this.ocrRepository.getByAssetId(asset.id, {});

    const faceStatuses = checkFaceVisibility(assetFaces, originalDimensions, cropBox);
    await this.personRepository.updateVisibility(faceStatuses.visible, faceStatuses.hidden);

    const ocrStatuses = checkOcrVisibility(ocrData, originalDimensions, cropBox);
    await this.ocrRepository.updateOcrVisibilities(asset.id, ocrStatuses.visible, ocrStatuses.hidden);

    return generated;
  }

  private warnOnTransparencyLoss(isTransparent: boolean, format: ImageFormat, assetId: string) {
    if (isTransparent && format === ImageFormat.Jpeg) {
      this.logger.warn(
        `Asset ${assetId} has transparency but the configured format is ${format} which does not support it, consider using a format that does, such as ${ImageFormat.Webp}`,
      );
    }
  }

  private getImageFile(
    asset: ThumbnailPathEntity,
    options: ImagePathOptions & { isProgressive: boolean; isTransparent: boolean },
  ) {
    const path = StorageCore.getImagePath(asset, options);
    return {
      assetId: asset.id,
      type: options.fileType,
      path,
      isEdited: options.isEdited,
      isProgressive: options.isProgressive,
      isTransparent: options.isTransparent,
    };
  }
}
