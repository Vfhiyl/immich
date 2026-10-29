import 'dart:async';
import 'dart:io';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:async/async.dart';
import 'package:flutter/widgets.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/infrastructure/loaders/image_request.dart';
import 'package:immich_mobile/infrastructure/repositories/settings.repository.dart';
import 'package:immich_mobile/presentation/widgets/images/local_image_provider.dart';
import 'package:immich_mobile/presentation/widgets/images/region_image.dart';
import 'package:immich_mobile/presentation/widgets/images/remote_image_provider.dart';
import 'package:immich_mobile/presentation/widgets/timeline/constants.dart';
import 'package:immich_mobile/utils/image_url_builder.dart';
import 'package:logging/logging.dart';
import 'package:openapi/api.dart' show AssetMediaSize;
import 'package:path/path.dart' as p;

// The provider is also the cache key and can be resolved more than once.
// Keep mutable state per load so cancelling one cannot affect the next load.
class ImageLoader {
  static final _log = Logger('ImageLoader');

  final ImageProvider key;
  bool isCancelled = false;
  bool isFinished = false;
  ImageRequest? request;
  CancelableOperation<ImageInfo?>? cachedOperation;

  ImageLoader(this.key);

  ImageInfo? getInitialImage(ImageProvider provider) {
    final completer = CancelableCompleter<ImageInfo?>();
    final cachedStream = provider.resolve(ImageConfiguration.empty);
    ImageInfo? cachedImage;
    final listener = ImageStreamListener((image, synchronousCall) {
      if (synchronousCall) {
        cachedImage = image;
      }

      if (!completer.isCompleted) {
        completer.complete(image);
      }
    }, onError: completer.completeError);

    cachedStream.addListener(listener);
    if (cachedImage != null) {
      cachedStream.removeListener(listener);
      return cachedImage;
    }

    unawaited(
      completer.operation.valueOrCancellation().whenComplete(() {
        cachedStream.removeListener(listener);
      }),
    );
    cachedOperation = completer.operation;
    return null;
  }

  Stream<ImageInfo> loadRequest(ImageRequest request, ImageDecoderCallback decode, {required bool isFinal}) async* {
    if (isCancelled) {
      this.request = null;
      return;
    }

    try {
      final image = await request.load(decode);
      if (isCancelled || image == null) {
        image?.dispose();
        return;
      }
      isFinished = isFinal;
      yield image;
    } catch (e, stack) {
      if (isCancelled) {
        return;
      }
      if (isFinal) {
        isFinished = true;
        PaintingBinding.instance.imageCache.evict(key);
        rethrow;
      }
      _log.warning('Non-fatal image load error', e, stack);
    } finally {
      this.request = null;
    }
  }

  Future<ui.Codec?> loadCodecRequest(ImageRequest request, {required bool isFinal}) async {
    if (isCancelled) {
      this.request = null;
      return null;
    }

    try {
      final codec = await request.loadCodec();
      if (isCancelled || codec == null) {
        codec?.dispose();
        return null;
      }
      isFinished = isFinal;
      return codec;
    } catch (e) {
      if (isCancelled) {
        return null;
      }
      if (isFinal) {
        isFinished = true;
        PaintingBinding.instance.imageCache.evict(key);
        rethrow;
      }
      return null;
    } finally {
      this.request = null;
    }
  }

  Stream<ImageInfo> initialImageStream() async* {
    final cachedOperation = this.cachedOperation;
    if (isCancelled || cachedOperation == null) {
      return;
    }

    try {
      final cachedImage = await cachedOperation.valueOrCancellation();
      if (isCancelled || cachedImage == null) {
        return;
      }
      yield cachedImage;
    } catch (e, stack) {
      if (isCancelled) {
        return;
      }
      _log.severe('Error loading initial image', e, stack);
    } finally {
      this.cachedOperation = null;
    }
  }

  void cancel() {
    isCancelled = true;
    final hasActiveWork = !isFinished;

    final request = this.request;
    if (request != null) {
      this.request = null;
      request.cancel();
    }

    final operation = cachedOperation;
    if (operation != null) {
      cachedOperation = null;
      unawaited(operation.cancel());
    }

    if (hasActiveWork) {
      PaintingBinding.instance.imageCache.evict(key);
    }
  }
}

/// [tiled]: shown in tiles, from [getRegionSource]: the provider decodes only the base. By default, wherever it can
/// be: the base is at most twice the pixels of [size] (on the screen), enough for what shows the image at that size
/// (slideshows, memories...), where a long screenshot would otherwise be decoded at up to 16384 pixels long.
ImageProvider getFullImageProvider(
  BaseAsset asset, {
  Size size = const Size(1080, 1920),
  bool edited = true,
  String? localFilePath,
  Size? remoteThumbnailSize,
  bool? tiled,
}) {
  tiled ??= localFilePath == null && getRegionSource(asset, size: size, edited: edited) != null;
  // Create new provider and cache it
  final ImageProvider provider;
  if (localFilePath != null) {
    provider = FileImage(File(localFilePath));
  } else if (_shouldUseLocalAsset(asset)) {
    final id = asset is LocalAsset ? asset.id : (asset as RemoteAsset).localId!;
    provider = LocalFullImageProvider(
      id: id,
      size: size,
      assetType: asset.type,
      isAnimated: asset.isAnimatedImage,
      width: asset.width,
      height: asset.height,
      checksum: asset.checksum,
      tiled: tiled,
    );
  } else {
    final String assetId;
    final String thumbhash;
    if (asset is LocalAsset && asset.hasRemote) {
      assetId = asset.remoteId!;
      thumbhash = "";
    } else if (asset is RemoteAsset) {
      assetId = asset.id;
      thumbhash = asset.thumbHash ?? "";
    } else {
      throw ArgumentError("Unsupported asset type: ${asset.runtimeType}");
    }
    provider = RemoteFullImageProvider(
      assetId: assetId,
      thumbhash: thumbhash,
      assetType: asset.type,
      isAnimated: asset.isAnimatedImage,
      edited: edited,
      thumbnailSize: remoteThumbnailSize,
      tiledBaseSize: tiled && asset.width != null && asset.height != null
          ? regionBaseSize(asset.width!, asset.height!, size * _devicePixelRatio)
          : null,
    );
  }

  return provider;
}

ImageProvider? getThumbnailImageProvider(
  BaseAsset asset, {
  Size size = kThumbnailResolution,

  /// Physical size to decode for remote thumbnails, or null for the source size.
  Size? remoteSize,
  bool edited = true,
}) {
  if (_shouldUseLocalAsset(asset)) {
    final id = asset is LocalAsset ? asset.id : (asset as RemoteAsset).localId!;
    return LocalThumbProvider(id: id, size: size, assetType: asset.type, checksum: asset.checksum);
  }

  final assetId = asset is RemoteAsset ? asset.id : (asset as LocalAsset).remoteId;
  final thumbhash = asset is RemoteAsset ? asset.thumbHash ?? "" : "";
  return assetId != null
      ? RemoteImageProvider.thumbnail(assetId: assetId, thumbhash: thumbhash, edited: edited, decodeSize: remoteSize)
      : null;
}

double get _devicePixelRatio => ui.PlatformDispatcher.instance.views.first.devicePixelRatio;

// what the app's decoders read in parts (native/region)
const _regionExtensions = {'.jpg', '.jpeg', '.png', '.heic', '.heif'};

// the server's previews: 1440 pixels on their short side (its default)
const _previewShortSide = 1440;

/// What the viewer shows [asset] from in tiles, on a screen of [size] logical pixels, or null where it is
/// decoded whole as before: on iOS (for now), for animated images and videos, formats the app's decoders do not read,
/// and images no larger than the base (tiles would show nothing more). It is the original of a local asset; of a
/// remote one, the preview (long images, whose previews are large), or the original if the settings load originals.
RegionSource? getRegionSource(
  BaseAsset asset, {
  required Size size,
  bool edited = true,
  @visibleForTesting bool? android,
}) {
  final (width, height) = (asset.width, asset.height);
  if (!(android ?? Platform.isAndroid) || !asset.isImage || asset.isAnimatedImage || width == null || height == null) {
    return null;
  }
  if (width <= 0 || height <= 0) {
    return null;
  }
  final base = regionBaseSize(width, height, size * _devicePixelRatio);
  final basePixels = base.width * base.height;
  final readable = _regionExtensions.contains(p.extension(asset.name).toLowerCase());
  final pixels = width * height;

  if (_shouldUseLocalAsset(asset)) {
    final id = asset is LocalAsset ? asset.id : (asset as RemoteAsset).localId!;
    return readable && pixels > basePixels ? RegionSource(localAssetId: id, basePixels: basePixels) : null;
  }

  final assetId = asset is RemoteAsset ? asset.id : (asset as LocalAsset).remoteId;
  if (assetId == null) {
    return null;
  }
  final previewScale = math.min(1.0, _previewShortSide / math.min(width, height));
  final previewPixels = pixels * previewScale * previewScale;
  if (SettingsRepository.instance.appConfig.image.loadOriginal) {
    // the base is the preview, which may be smaller
    return readable && pixels > basePixels
        ? RegionSource(
            url: getOriginalUrlForRemoteId(assetId, edited: edited),
            basePixels: math.min(basePixels, previewPixels),
          )
        : null;
  }
  final thumbhash = asset is RemoteAsset ? asset.thumbHash ?? "" : "";
  return previewPixels > basePixels
      ? RegionSource(
          url: getThumbnailUrlForRemoteId(assetId, type: AssetMediaSize.preview, thumbhash: thumbhash, edited: edited),
          basePixels: basePixels,
        )
      : null;
}

bool _shouldUseLocalAsset(BaseAsset asset) =>
    asset.hasLocal &&
    (!asset.hasRemote || !SettingsRepository.instance.appConfig.image.preferRemote) &&
    !asset.isEdited;
