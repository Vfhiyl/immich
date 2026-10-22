import 'package:pigeon/pigeon.dart';

@ConfigurePigeon(
  PigeonOptions(
    dartOut: 'lib/platform/user_upload_api.g.dart',
    kotlinOut: 'android/app/src/main/kotlin/app/alextran/immich/background/UserUpload.g.kt',
    kotlinOptions: KotlinOptions(package: 'app.alextran.immich.background', includeErrorClass: false),
    dartOptions: DartOptions(),
    dartPackageName: 'immich_mobile',
  ),
)
/// Keeps a backup that runs while the app is open going when the user leaves the app (Android 14+)
@HostApi()
abstract class UserUploadApi {
  /// Called while the app is in front; returns whether the backup goes on when the user leaves the app
  bool start();

  void finish();
}
