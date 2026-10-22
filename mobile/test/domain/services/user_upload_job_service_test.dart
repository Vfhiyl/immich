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
  });

  tearDown(() => debugDefaultTargetPlatformOverride = null);

  test('keeps the backup going on Android', () async {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    when(() => api.start()).thenAnswer((_) async => true);
    when(() => api.finish()).thenAnswer((_) async {});

    expect(await sut.start(), isTrue);
    await sut.finish();

    verify(() => api.finish()).called(1);
  });

  test('tells that the backup stops when the system does not take the job', () async {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    when(() => api.start()).thenThrow(PlatformException(code: 'error'));

    expect(await sut.start(), isFalse);
  });

  test('does nothing on iOS', () async {
    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;

    expect(await sut.start(), isFalse);
    await sut.finish();

    verifyZeroInteractions(api);
  });
}
