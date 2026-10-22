import 'dart:async';
import 'dart:isolate';

import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/utils/background_sync.dart';

void main() {
  test('passes on the progress reported in another isolate', () async {
    final received = <int>[];
    final done = Completer<void>();
    final relay = RemoteSyncProgressRelay((assets) {
      received.add(assets);
      if (assets == 300) {
        done.complete();
      }
    });
    addTearDown(relay.close);

    await Isolate.run(() {
      final report = RemoteSyncProgressRelay.reporter()!;
      report(100);
      report(300);
    });
    await done.future.timeout(const Duration(seconds: 5));

    expect(received, [100, 300]);
  });

  test('reports to the newest relay only, and to none once it is closed', () async {
    final first = <int>[];
    final second = <int>[];
    final old = RemoteSyncProgressRelay(first.add);
    final current = RemoteSyncProgressRelay(second.add);

    RemoteSyncProgressRelay.reporter()!(1);
    await pumpEventQueue();
    old.close();
    // closing an older relay leaves the newer one
    expect(RemoteSyncProgressRelay.reporter(), isNotNull);
    current.close();

    expect(first, isEmpty);
    expect(second, [1]);
    expect(RemoteSyncProgressRelay.reporter(), isNull);
  });
}
