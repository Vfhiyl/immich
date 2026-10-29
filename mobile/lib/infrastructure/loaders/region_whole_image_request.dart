part of 'image_request.dart';

/// A remote image shown in tiles, decoded whole for its base by the app's own decoders, from the cache file its tiles
/// are decoded from: it is downloaded once for both (see RegionImageApi.decodeWhole).
class RegionWholeImageRequest extends ImageRequest {
  final String uri;

  /// Physical size to decode at least
  final ui.Size decodeSize;

  final RegionImageApi _api;

  RegionWholeImageRequest({required this.uri, required this.decodeSize, @visibleForTesting RegionImageApi? api})
    : _api = api ?? regionImageApi;

  @override
  Future<ImageInfo?> load(ImageDecoderCallback decode, {double scale = 1.0}) async {
    if (_isCancelled) {
      return null;
    }

    final info = await _api.decodeWhole(
      uri,
      requestId: requestId,
      width: decodeSize.width.ceil(),
      height: decodeSize.height.ceil(),
    );
    final frame = switch (info) {
      {
        'pointer': final int pointer,
        'width': final int width,
        'height': final int height,
        'rowBytes': final int rowBytes,
      } =>
        await _fromDecodedPlatformImage(pointer, width, height, rowBytes),
      _ => null,
    };
    return frame == null ? null : ImageInfo(image: frame.image, scale: scale);
  }

  // (not animated: the formats of the app's decoders, as still images)
  @override
  Future<ui.Codec?> loadCodec() async => null;

  @override
  Future<void> _onCancelled() {
    return _api.cancel(requestId);
  }
}
