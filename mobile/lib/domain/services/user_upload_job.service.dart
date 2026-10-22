import 'package:immich_mobile/extensions/platform_extensions.dart';
import 'package:immich_mobile/platform/user_upload_api.g.dart';
import 'package:logging/logging.dart';

/// Keeps a backup that runs while the app is open going when the user leaves the app: on Android 14 and later, as a
/// user-initiated data transfer job (with a notification). Elsewhere the backup stops when the user leaves the app,
/// and goes on from where it was the next time the app is opened
class UserUploadJobService {
  final UserUploadApi _hostApi;
  final _log = Logger('UserUploadJobService');

  UserUploadJobService(this._hostApi);

  /// Call while the app is in front; returns whether the backup goes on when the user leaves the app
  Future<bool> start() async {
    if (!CurrentPlatform.isAndroid) {
      return false;
    }
    try {
      return await _hostApi.start();
    } catch (error, stackTrace) {
      _log.warning('Could not keep the backup going in the background', error, stackTrace);
      return false;
    }
  }

  Future<void> finish() async {
    if (!CurrentPlatform.isAndroid) {
      return;
    }
    try {
      await _hostApi.finish();
    } catch (error, stackTrace) {
      _log.warning('Could not end the background backup', error, stackTrace);
    }
  }
}
