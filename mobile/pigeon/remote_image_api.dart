import 'package:pigeon/pigeon.dart';

@ConfigurePigeon(
  PigeonOptions(
    dartOut: 'lib/platform/remote_image_api.g.dart',
    swiftOut: 'ios/Runner/Images/RemoteImages.g.swift',
    swiftOptions: SwiftOptions(includeErrorClass: false),
    kotlinOut: 'android/app/src/main/kotlin/app/alextran/immich/images/RemoteImages.g.kt',
    kotlinOptions: KotlinOptions(package: 'app.alextran.immich.images', includeErrorClass: false),
    dartOptions: DartOptions(),
    dartPackageName: 'immich_mobile',
  ),
)
@HostApi()
abstract class RemoteImageApi {
  /// Width and height are the physical decode size, or null for the source size. [crop]: only the middle of the
  /// image with their aspect, covering them (a tile of a grid shows that much of a long image)
  @async
  Map<String, int>? requestImage(
    String url, {
    required int requestId,
    required bool preferEncoded,
    int? width,
    int? height,
    required bool crop,
  });

  void cancelRequest(int requestId);

  @async
  int clearCache();
}
