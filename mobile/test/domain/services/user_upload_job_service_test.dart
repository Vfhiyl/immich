import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/services/user_upload_job.service.dart';
import 'package:immich_mobile/platform/user_upload_api.g.dart';
import 'package:mocktail/mocktail.dart';

class MockUserUploadApi extends Mock implements UserUploadApi {}

void main() {
  late MockUserUploadApi api;
  late UserUploadJobService sut;

  setUp(() {
    api = MockUserUploadApi();
    sut = UserUploadJobService(api);
    when(() => api.start(any(), any())).thenAnswer((_) async => true);
    when(() => api.progress(any(), any())).thenAnswer((_) async {});
    when(() => api.finish()).thenAnswer((_) async {});
  });

  tearDown(() => debugDefaultTargetPlatformOverride = null);

  test('keeps the backup going on Android, also when the app started it by itself', () async {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;

    expect(await sut.start(isUserInitiated: false), isTrue);
    await sut.progress(1, 2);
    await sut.finish();

    verify(() => api.progress(1, 2)).called(1);
    verify(() => api.finish()).called(1);
  });

  test('tells that the backup stops when the system does not take the job', () async {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    when(() => api.start(any(), any())).thenThrow(PlatformException(code: 'error'));

    expect(await sut.start(isUserInitiated: true), isFalse);
  });

  test('keeps the backup going on iOS only when the user started it', () async {
    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;

    expect(await sut.start(isUserInitiated: false), isFalse);
    verifyNever(() => api.start(any(), any()));

    expect(await sut.start(isUserInitiated: true), isTrue);
    verify(() => api.start(any(that: isNotEmpty), any(that: isNotEmpty))).called(1);
  });

  test('passes on that the backup was stopped in the background', () {
    var stopped = 0;
    sut.onStoppedInBackground = () => stopped++;

    sut.onStopped();

    expect(stopped, 1);
  });
}
