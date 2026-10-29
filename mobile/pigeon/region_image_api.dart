import 'package:pigeon/pigeon.dart';

// Android only for now: iOS gets its implementation (and swiftOut) with the same C decoders later
@ConfigurePigeon(
  PigeonOptions(
    dartOut: 'lib/platform/region_image_api.g.dart',
    kotlinOut: 'android/app/src/main/kotlin/app/alextran/immich/images/RegionImages.g.kt',
    kotlinOptions: KotlinOptions(package: 'app.alextran.immich.images', includeErrorClass: false),
    dartOptions: DartOptions(),
    dartPackageName: 'immich_mobile',
  ),
)
/// Decodes parts of very large images with the app's own decoders (native/region), never the whole image.
@HostApi()
abstract class RegionImageApi {
  /// Opens a local asset, or a remote image (downloaded to a cache file first). Returns `id`, and the `width` and
  /// `height` of the image upright, or null if cancelled; fails if its format cannot be decoded in parts.
  @async
  Map<String, int>? open({String? localAssetId, String? url, required int requestId});

  /// Decodes the part (`x`, `y`, `width`, `height`, in pixels of the image upright) `sample` times smaller. Returns
  /// `pointer` (RGBA, freed by the caller), `width`, `height` and `rowBytes`, or null if cancelled.
  @async
  Map<String, int>? decode(
    int imageId, {
    required int requestId,
    required int x,
    required int y,
    required int width,
    required int height,
    required int sample,
  });

  /// Decodes a remote image whole, made smaller to about `width` x `height` (at least, either way round), from the
  /// cache file that [open] uses too (downloaded first if it is not there): a remote image shown in tiles is
  /// downloaded once, for its base and its tiles. Returns `pointer` (RGBA, freed by the caller), `width`, `height` and
  /// `rowBytes`, or null if cancelled.
  @async
  Map<String, int>? decodeWhole(String url, {required int requestId, required int width, required int height});

  /// Cancels an open or a decode that has not finished.
  void cancel(int requestId);

  void close(int imageId);
}
