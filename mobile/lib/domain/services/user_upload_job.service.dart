import 'package:immich_mobile/extensions/platform_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/platform/user_upload_api.g.dart';
import 'package:logging/logging.dart';

/// Keeps a backup that runs while the app is open going when the user leaves the app: on Android 14 and later, as a
/// user-initiated data transfer job (with a notification); on iOS 26 and later, as a continued processing task (with
/// its progress shown by the system), only for a backup the user started, as Apple requires. Elsewhere the backup
/// stops when the user leaves the app, and goes on from where it was the next time the app is opened
class UserUploadJobService implements UserUploadFlutterApi {
  final UserUploadApi _hostApi;
  final _log = Logger('UserUploadJobService');

  /// Called when the system, or the user where the system shows the backup, stopped it in the background
  void Function()? onStoppedInBackground;

  UserUploadJobService(this._hostApi);

  /// Call while the app is in front, with whether the user started the backup just now (e.g. by a tap); returns
  /// whether the backup goes on when the user leaves the app
  Future<bool> start({required bool isUserInitiated}) async {
    // iOS: "your app needs to run the task only in response to someone's action, such as tapping a button"
    if (!(CurrentPlatform.isAndroid || (CurrentPlatform.isIOS && isUserInitiated))) {
      return false;
    }
    try {
      return await _hostApi.start(
        StaticTranslations.instance.uploading_media,
        StaticTranslations.instance.backup_background_service_in_progress_notification,
      );
    } catch (error, stackTrace) {
      _log.warning('Could not keep the backup going in the background', error, stackTrace);
      return false;
    }
  }

  /// How far the backup is: the system stops a task that seems stuck (iOS)
  Future<void> progress(int completed, int total) async {
    try {
      await _hostApi.progress(completed, total);
    } catch (error, stackTrace) {
      _log.warning('Could not report the progress of the backup', error, stackTrace);
    }
  }

  Future<void> finish() async {
    try {
      await _hostApi.finish();
    } catch (error, stackTrace) {
      _log.warning('Could not end the background backup', error, stackTrace);
    }
  }

  @override
  void onStopped() {
    _log.info('The backup in the background was stopped');
    onStoppedInBackground?.call();
  }
}
