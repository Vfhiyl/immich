import 'package:pigeon/pigeon.dart';

@ConfigurePigeon(
  PigeonOptions(
    dartOut: 'lib/platform/user_upload_api.g.dart',
    swiftOut: 'ios/Runner/Background/UserUpload.g.swift',
    swiftOptions: SwiftOptions(includeErrorClass: false),
    kotlinOut: 'android/app/src/main/kotlin/app/alextran/immich/background/UserUpload.g.kt',
    kotlinOptions: KotlinOptions(package: 'app.alextran.immich.background', includeErrorClass: false),
    dartOptions: DartOptions(),
    dartPackageName: 'immich_mobile',
  ),
)
/// Keeps a backup that runs while the app is open going when the user leaves the app: a user-initiated data transfer
/// job on Android 14+, a continued processing task on iOS 26+
@HostApi()
abstract class UserUploadApi {
  /// Called while the app is in front; returns whether the backup goes on when the user leaves the app. [title] and
  /// [subtitle] describe the backup where the system shows its progress (iOS)
  bool start(String title, String subtitle);

  /// How far the backup is, in units of the backup's own choice
  void progress(int completed, int total);

  void finish();
}

@FlutterApi()
abstract class UserUploadFlutterApi {
  /// The system stopped the backup in the background, or the user did where the system shows it (iOS)
  void onStopped();
}
