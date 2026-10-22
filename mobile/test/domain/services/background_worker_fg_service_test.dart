import 'package:drift/drift.dart' as drift;
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/data/db/main/database.dart';
import 'package:immich_mobile/domain/models/settings_key.dart';
import 'package:immich_mobile/domain/services/background_worker.service.dart';
import 'package:immich_mobile/infrastructure/repositories/settings.repository.dart';
import 'package:immich_mobile/platform/background_worker_api.g.dart';
import 'package:mocktail/mocktail.dart';

class _MockForegroundHostApi extends Mock implements BackgroundWorkerFgHostApi {}

void main() {
  late _MockForegroundHostApi hostApi;
  late BackgroundWorkerFgService sut;

  setUpAll(() async {
    final db = Drift(drift.DatabaseConnection(NativeDatabase.memory(), closeStreamsSynchronously: true));
    await SettingsRepository.ensureInitialized(db);
    registerFallbackValue(BackgroundWorkerSettings(requiresCharging: false, minimumDelaySeconds: 0));
  });

  setUp(() {
    hostApi = _MockForegroundHostApi();
    when(() => hostApi.configure(any())).thenAnswer((_) async {});
    sut = BackgroundWorkerFgService(hostApi);
  });

  BackgroundWorkerSettings configured() =>
      verify(() => hostApi.configure(captureAny())).captured.single as BackgroundWorkerSettings;

  test('only backs up in the background while charging, whatever was set before', () async {
    await SettingsRepository.instance.write(SettingsKey.backupRequireCharging, false);

    await sut.configure();

    expect(configured().requiresCharging, isTrue);
  });

  test('passes on the delay after new photos, as set or as given', () async {
    await SettingsRepository.instance.write(SettingsKey.backupTriggerDelay, 120);
    await sut.configure();
    expect(configured().minimumDelaySeconds, 120);

    await sut.configure(minimumDelaySeconds: 600);
    expect(configured().minimumDelaySeconds, 600);
  });
}
