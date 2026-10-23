import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/providers/backup/backup.provider.dart';
import 'package:immich_mobile/services/background_upload.service.dart';
import 'package:immich_mobile/services/foreground_upload.service.dart';
import 'package:immich_mobile/utils/upload_speed_calculator.dart';
import 'package:mocktail/mocktail.dart';

import '../../service.mocks.dart' show MockUserUploadJobService;

class MockForegroundUploadService extends Mock implements ForegroundUploadService {}

class MockBackgroundUploadService extends Mock implements BackgroundUploadService {}

void main() {
  late MockForegroundUploadService foregroundUploadService;
  late MockBackgroundUploadService backgroundUploadService;
  late MockUserUploadJobService userUploadJob;
  late BackupNotifier notifier;

  setUpAll(() {
    registerFallbackValue(Completer<void>());
    registerFallbackValue(const UploadCallbacks());
  });

  setUp(() {
    foregroundUploadService = MockForegroundUploadService();
    backgroundUploadService = MockBackgroundUploadService();
    userUploadJob = MockUserUploadJobService();
    when(() => userUploadJob.start(isUserInitiated: any(named: 'isUserInitiated'))).thenAnswer((_) async => false);
    when(() => userUploadJob.finish()).thenAnswer((_) async {});
    when(() => userUploadJob.progress(any(), any())).thenAnswer((_) async {});
    notifier = BackupNotifier(foregroundUploadService, backgroundUploadService, UploadSpeedManager(), userUploadJob);
    addTearDown(() {
      if (notifier.mounted) {
        notifier.dispose();
      }
    });
  });

  void mockCounts({required int total, required int remainder, int processing = 0}) {
    when(
      () => foregroundUploadService.getBackupCounts('user-1'),
    ).thenAnswer((_) async => (total: total, remainder: remainder, processing: processing));
  }

  // Drives a backup run so we can grab the onSuccess callback the notifier wires up.
  Future<void Function(String, String)> startAndCaptureOnSuccess() async {
    void Function(String, String)? onSuccess;
    when(() => foregroundUploadService.uploadCandidates(any(), any(), callbacks: any(named: 'callbacks'))).thenAnswer((
      invocation,
    ) async {
      onSuccess = (invocation.namedArguments[#callbacks] as UploadCallbacks).onSuccess;
    });
    await notifier.startForegroundBackup('user-1');
    return onSuccess!;
  }

  group('foreground backup counts', () {
    test('successes move one asset from remainder to backup', () async {
      mockCounts(total: 25, remainder: 25);
      final onSuccess = await startAndCaptureOnSuccess();

      for (var i = 0; i < 10; i++) {
        onSuccess('asset-$i', 'remote-$i');
      }

      expect(notifier.state.remainderCount, 15);
      expect(notifier.state.backupCount, 10);
      expect(notifier.state.backupCount + notifier.state.remainderCount, notifier.state.totalCount);
    });

    test('a duplicate success after pause and resume cannot go below zero', () async {
      // #26215: app pauses mid-backup, sync has not recorded the upload yet, so the
      // resumed run re-uploads the same asset and the server answers 200 duplicate.
      // The start of each run re-baselines the counters from the DB, so the duplicate
      // success is counted against a baseline that includes the asset again.
      mockCounts(total: 1, remainder: 1);

      final firstRun = await startAndCaptureOnSuccess();
      expect(notifier.state.remainderCount, 1);
      firstRun('asset-1', 'remote-1');
      expect(notifier.state.remainderCount, 0);

      notifier.stopForegroundBackup(reason: "test");

      final resumedRun = await startAndCaptureOnSuccess();
      expect(notifier.state.remainderCount, 1);
      verify(() => foregroundUploadService.getBackupCounts('user-1')).called(2);

      resumedRun('asset-1', 'remote-1');
      expect(notifier.state.remainderCount, 0);
      expect(notifier.state.backupCount, 1);
    });

    test('a drifted counter state heals at run start', () async {
      mockCounts(total: 91, remainder: 7);
      notifier.state = notifier.state.copyWith(totalCount: 91, backupCount: 103, remainderCount: -12);

      await startAndCaptureOnSuccess();

      expect(notifier.state.totalCount, 91);
      expect(notifier.state.remainderCount, 7);
      expect(notifier.state.backupCount, 84);
    });

    test('a late success after dispose does not throw', () async {
      mockCounts(total: 2, remainder: 2);
      final onSuccess = await startAndCaptureOnSuccess();
      notifier.dispose();

      onSuccess('asset-1', 'remote-1');
    });
  });

  group('backup in the background', () {
    void mockUpload(Future<void> Function(Completer<void> cancelToken) upload) {
      when(
        () => foregroundUploadService.uploadCandidates(any(), any(), callbacks: any(named: 'callbacks')),
      ).thenAnswer((invocation) => upload(invocation.positionalArguments[1] as Completer<void>));
    }

    test('goes on when the user leaves the app, and ends with the backup', () async {
      mockCounts(total: 3, remainder: 3);
      when(() => userUploadJob.start(isUserInitiated: any(named: 'isUserInitiated'))).thenAnswer((_) async => true);
      final uploading = Completer<void>();
      final done = Completer<void>();
      mockUpload((_) {
        uploading.complete();
        return done.future;
      });

      final run = notifier.startForegroundBackup('user-1');
      await uploading.future;

      expect(notifier.isBackingUp, isTrue);
      expect(notifier.continuesInBackground, isTrue);
      verifyNever(() => userUploadJob.finish());

      done.complete();
      await run;

      expect(notifier.isBackingUp, isFalse);
      expect(notifier.continuesInBackground, isFalse);
      verify(() => userUploadJob.finish()).called(1);
    });

    test('does not start for nothing to back up', () async {
      mockCounts(total: 3, remainder: 0);
      mockUpload((_) async {});

      await notifier.startForegroundBackup('user-1');

      verifyNever(() => userUploadJob.start(isUserInitiated: any(named: 'isUserInitiated')));
      expect(notifier.isBackingUp, isFalse);
    });

    test('stops with the backup', () async {
      mockCounts(total: 3, remainder: 3);
      when(() => userUploadJob.start(isUserInitiated: any(named: 'isUserInitiated'))).thenAnswer((_) async => true);
      mockUpload((cancelToken) => cancelToken.future);

      final run = notifier.startForegroundBackup('user-1');
      await untilCalled(
        () => foregroundUploadService.uploadCandidates(any(), any(), callbacks: any(named: 'callbacks')),
      );
      notifier.stopForegroundBackup(reason: 'test');
      await run;

      expect(notifier.continuesInBackground, isFalse);
      verify(() => userUploadJob.finish()).called(1);
    });

    test('is not ended by a backup that was replaced', () async {
      mockCounts(total: 3, remainder: 3);
      when(() => userUploadJob.start(isUserInitiated: any(named: 'isUserInitiated'))).thenAnswer((_) async => true);
      final runs = <Completer<void>>[];
      mockUpload((cancelToken) {
        runs.add(cancelToken);
        // the first one ends only after the second started
        return runs.length == 1 ? Future<void>.delayed(const Duration(milliseconds: 10)) : Completer<void>().future;
      });

      final first = notifier.startForegroundBackup('user-1');
      await untilCalled(
        () => foregroundUploadService.uploadCandidates(any(), any(), callbacks: any(named: 'callbacks')),
      );
      unawaited(notifier.startForegroundBackup('user-1'));
      await first;
      await Future<void>.delayed(Duration.zero);

      expect(runs, hasLength(2));
      expect(notifier.isBackingUp, isTrue);
      expect(notifier.continuesInBackground, isTrue);
      // once, for the first one, stopped when the second started
      verify(() => userUploadJob.finish()).called(1);
    });

    test('passes on whether the user started it, which iOS needs', () async {
      mockCounts(total: 3, remainder: 3);
      mockUpload((_) async {});

      await notifier.startForegroundBackup('user-1', isUserInitiated: true);
      await notifier.startForegroundBackup('user-1');

      verify(() => userUploadJob.start(isUserInitiated: true)).called(1);
      verify(() => userUploadJob.start(isUserInitiated: false)).called(1);
    });

    test('reports its progress, counting the files that are uploading', () async {
      mockCounts(total: 3, remainder: 2);
      when(() => userUploadJob.start(isUserInitiated: any(named: 'isUserInitiated'))).thenAnswer((_) async => true);
      late UploadCallbacks callbacks;
      final done = Completer<void>();
      when(() => foregroundUploadService.uploadCandidates(any(), any(), callbacks: any(named: 'callbacks'))).thenAnswer(
        (invocation) {
          callbacks = invocation.namedArguments[#callbacks] as UploadCallbacks;
          return done.future;
        },
      );

      final run = notifier.startForegroundBackup('user-1', isUserInitiated: true);
      await untilCalled(
        () => foregroundUploadService.uploadCandidates(any(), any(), callbacks: any(named: 'callbacks')),
      );
      verify(() => userUploadJob.progress(0, 2000)).called(1);

      // after a second, the next change is reported: one file done, the other half uploaded
      await Future<void>.delayed(const Duration(milliseconds: 1100));
      callbacks.onSuccess!('asset-1', 'remote-1');
      await Future<void>.delayed(const Duration(milliseconds: 1100));
      callbacks.onProgress!('asset-2', 'b.jpg', 50, 100);
      verify(() => userUploadJob.progress(1000, 2000)).called(1);
      verify(() => userUploadJob.progress(1500, 2000)).called(1);

      done.complete();
      await run;
    });

    test('stops when it is stopped in the background', () async {
      final onStopped =
          verify(() => userUploadJob.onStoppedInBackground = captureAny()).captured.single as void Function();
      mockCounts(total: 3, remainder: 3);
      when(() => userUploadJob.start(isUserInitiated: any(named: 'isUserInitiated'))).thenAnswer((_) async => true);
      mockUpload((cancelToken) => cancelToken.future);

      final run = notifier.startForegroundBackup('user-1', isUserInitiated: true);
      await untilCalled(
        () => foregroundUploadService.uploadCandidates(any(), any(), callbacks: any(named: 'callbacks')),
      );
      onStopped();
      await run;

      expect(notifier.isBackingUp, isFalse);
      expect(notifier.continuesInBackground, isFalse);
      verify(() => userUploadJob.finish()).called(1);
    });

    test('is ended when the backup stops while it is started', () async {
      mockCounts(total: 3, remainder: 3);
      final starting = Completer<bool>();
      when(
        () => userUploadJob.start(isUserInitiated: any(named: 'isUserInitiated')),
      ).thenAnswer((_) => starting.future);
      mockUpload((_) async {});

      final run = notifier.startForegroundBackup('user-1');
      await untilCalled(() => userUploadJob.start(isUserInitiated: any(named: 'isUserInitiated')));
      notifier.stopForegroundBackup(reason: 'test');
      starting.complete(true);
      await run;

      expect(notifier.continuesInBackground, isFalse);
      verify(() => userUploadJob.finish()).called(1);
    });
  });

  group('why assets wait, and trying again', () {
    test('tells how many assets wait for Wi-Fi, until the backup stops', () async {
      mockCounts(total: 3, remainder: 3);
      when(() => foregroundUploadService.uploadCandidates(any(), any(), callbacks: any(named: 'callbacks'))).thenAnswer(
        (invocation) async => (invocation.namedArguments[#callbacks] as UploadCallbacks).onWaitingForWifi?.call(2),
      );

      await notifier.startForegroundBackup('user-1');
      expect(notifier.state.waitingForWifiCount, 2);

      notifier.stopForegroundBackup(reason: 'test');
      expect(notifier.state.waitingForWifiCount, 0);
    });

    test('tries again what failed, without the failures shown any longer', () async {
      mockCounts(total: 3, remainder: 3);
      var runs = 0;
      when(() => foregroundUploadService.uploadCandidates(any(), any(), callbacks: any(named: 'callbacks'))).thenAnswer(
        (invocation) async {
          runs++;
          if (runs == 1) {
            final callbacks = invocation.namedArguments[#callbacks] as UploadCallbacks;
            callbacks.onError?.call('asset-1', 'server error');
            callbacks.onProgress?.call('asset-2', 'b.jpg', 10, 100);
          }
        },
      );
      await notifier.startForegroundBackup('user-1');
      expect(notifier.state.errorCount, 1);

      await notifier.retryFailed('user-1');

      expect(runs, 2);
      expect(notifier.state.errorCount, 0);
      expect(notifier.state.uploadItems.keys, ['asset-2']);
    });
  });
}
