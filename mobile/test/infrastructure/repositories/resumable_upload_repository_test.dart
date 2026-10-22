import 'dart:async';
import 'dart:io';
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/infrastructure/repositories/resumable_upload.repository.dart';

import 'fake_resumable_upload_server.dart';

const endpoint = 'https://immich.example.com/api';

void main() {
  late Directory directory;
  late FakeResumableUploadServer server;
  late InMemoryResumableUploadSessionStore sessions;
  late ResumableUploadRepository sut;
  final random = Random(42);
  const assetData = {'filename': 'IMG_0001.jpg', 'fileCreatedAt': '2026-10-22T10:00:00.000Z'};
  const options = ResumableUploadOptions(maxAppendSize: 1000);

  Future<File> writeFile(int size, {String name = 'photo.jpg'}) async {
    final file = File('${directory.path}/$name');
    await file.writeAsBytes(List.generate(size, (_) => random.nextInt(256)));
    return file;
  }

  Future<ResumableUploadOutcome> upload(File file, {String? sessionKey = 'asset-1', Future<void>? cancel}) =>
      sut.upload(
        endpoint: endpoint,
        file: file,
        assetData: assetData,
        headers: {'x-immich-user-token': 'token'},
        sessionKey: sessionKey,
        options: options,
        cancel: cancel,
      );

  setUp(() async {
    directory = await Directory.systemTemp.createTemp('resumable-upload-test');
    server = FakeResumableUploadServer();
    sessions = InMemoryResumableUploadSessionStore();
    sut = ResumableUploadRepository(server.client, sessions, retryDelays: const [Duration.zero, Duration.zero]);
  });

  tearDown(() async {
    await directory.delete(recursive: true);
  });

  group('getOptions', () {
    test('tells the largest part the server takes', () async {
      server.maxAppendSize = 100000000;
      final options = await sut.getOptions(endpoint);
      expect(options?.maxAppendSize, 100000000);
    });

    test('tells a server that does not take resumable uploads', () async {
      server.supportsUploads = false;
      expect(await sut.getOptions(endpoint), isNull);
    });
  });

  test('uploads a file in parts no larger than the server takes, with what describes it', () async {
    final file = await writeFile(2500);

    final outcome = await upload(file);

    expect(outcome, isA<ResumableUploadSucceeded>().having((o) => o.assetId, 'assetId', 'asset-upload-1'));
    final uploaded = server.uploads['upload-1']!;
    expect(uploaded.received, await file.readAsBytes());
    expect(uploaded.assetData, assetData);
    expect(server.requests, [
      'POST /api/upload',
      'HEAD /api/upload/upload-1',
      'PATCH /api/upload/upload-1',
      'PATCH /api/upload/upload-1',
      'PATCH /api/upload/upload-1',
    ]);
    // done: nothing is kept to resume
    expect(sessions.sessions, isEmpty);
  });

  test('does not send a file the user has already', () async {
    final file = await writeFile(100);
    server.existingChecksums[await ResumableUploadRepository.hashFile(file)] = 'existing-asset';

    final outcome = await upload(file);

    expect(
      outcome,
      isA<ResumableUploadSucceeded>()
          .having((o) => o.assetId, 'assetId', 'existing-asset')
          .having((o) => o.isDuplicate, 'isDuplicate', true),
    );
    expect(server.requests, ['POST /api/upload']);
  });

  test('resumes where the server stopped receiving, when the connection is cut', () async {
    final file = await writeFile(2500);
    server.cutAfter = 300;

    final outcome = await upload(file);

    expect(outcome, isA<ResumableUploadSucceeded>());
    expect(server.uploads['upload-1']!.received, await file.readAsBytes());
    // asked the server how far it got, and went on from there
    expect(server.requests.where((request) => request.startsWith('HEAD')), hasLength(2));
  });

  test('resumes an upload of the app before it was stopped, without starting a new one', () async {
    final file = await writeFile(2500);
    server.cutAfter = 300;
    sut = ResumableUploadRepository(server.client, sessions, retryDelays: const []);
    final first = await upload(file);
    expect(first, isA<ResumableUploadFailed>().having((o) => o.canResume, 'canResume', true));
    expect(sessions.sessions, contains('asset-1'));

    // the app starts again
    sut = ResumableUploadRepository(server.client, sessions);
    final outcome = await upload(file);

    expect(outcome, isA<ResumableUploadSucceeded>());
    expect(server.uploads, hasLength(1));
    expect(server.uploads['upload-1']!.received, await file.readAsBytes());
  });

  test('learns the asset of an upload that completed when the response was lost', () async {
    final file = await writeFile(500);
    await upload(file);
    const location = '/api/upload/upload-1';
    sessions.put(
      'asset-1',
      ResumableUploadSession(location: location, size: 500, sha1: await ResumableUploadRepository.hashFile(file)),
    );
    server.requests.clear();

    final outcome = await upload(file);

    expect(outcome, isA<ResumableUploadSucceeded>().having((o) => o.assetId, 'assetId', 'asset-upload-1'));
    expect(server.requests, ['HEAD $location']);
  });

  test('starts again when the server no longer knows the upload', () async {
    final file = await writeFile(500);
    sessions.put(
      'asset-1',
      ResumableUploadSession(
        location: '/api/upload/expired',
        size: 500,
        sha1: await ResumableUploadRepository.hashFile(file),
      ),
    );

    final outcome = await upload(file);

    expect(outcome, isA<ResumableUploadSucceeded>());
    expect(server.requests.first, 'HEAD /api/upload/expired');
    expect(server.uploads, hasLength(1));
  });

  test('does not resume the upload of a file that changed since', () async {
    final file = await writeFile(500);
    sessions.put('asset-1', const ResumableUploadSession(location: '/api/upload/old', size: 500, sha1: 'other'));

    await upload(file);

    expect(server.requests.first, 'POST /api/upload');
  });

  test('gives up on an upload the server rejected, and forgets it', () async {
    final file = await writeFile(500);
    server.failNextPart = 400;

    final outcome = await upload(file);

    expect(
      outcome,
      isA<ResumableUploadFailed>()
          .having((o) => o.statusCode, 'statusCode', 400)
          .having((o) => o.message, 'message', 'The part failed')
          .having((o) => o.canResume, 'canResume', false),
    );
    expect(sessions.sessions, isEmpty);
  });

  test('tries again after an error of the server', () async {
    final file = await writeFile(500);
    server.failNextPart = 503;

    expect(await upload(file), isA<ResumableUploadSucceeded>());
  });

  test('stops when cancelled, and keeps the upload to resume', () async {
    final file = await writeFile(2500);
    final cancel = Completer<void>();
    cancel.complete();

    final outcome = await upload(file, cancel: cancel.future);

    expect(outcome, isA<ResumableUploadCancelled>());
  });

  test('reports progress up to the whole file', () async {
    final file = await writeFile(2500);
    final progress = <int>[];

    await sut.upload(
      endpoint: endpoint,
      file: file,
      assetData: assetData,
      headers: const {},
      options: options,
      onProgress: (bytes, total) {
        expect(total, 2500);
        progress.add(bytes);
      },
    );

    expect(progress.last, 2500);
    expect(progress, orderedEquals([...progress]..sort()));
  });

  group('FileResumableUploadSessionStore', () {
    const session = ResumableUploadSession(location: '/api/upload/1', size: 10, sha1: 'sha');

    test('keeps uploads in progress by their key, also for another instance', () async {
      final store = FileResumableUploadSessionStore(Directory('${directory.path}/sessions'));
      expect(await store.get('a'), isNull);

      await store.put('a', session);
      await store.put('b/with:odd?characters', session);

      final other = FileResumableUploadSessionStore(Directory('${directory.path}/sessions'));
      expect((await other.get('a'))?.location, '/api/upload/1');
      expect(await other.get('b/with:odd?characters'), isNotNull);
      await other.remove('a');
      await other.remove('a');
      expect(await store.get('a'), isNull);
    });

    test('keeps every upload when many change at once', () async {
      final store = FileResumableUploadSessionStore(Directory('${directory.path}/sessions'));
      await Future.wait([for (var i = 0; i < 50; i++) store.put('$i', session)]);
      for (var i = 0; i < 50; i++) {
        expect(await store.get('$i'), isNotNull);
      }
    });

    test('forgets what it cannot read', () async {
      final store = FileResumableUploadSessionStore(Directory('${directory.path}/sessions'));
      await store.put('a', session);
      for (final file in Directory('${directory.path}/sessions').listSync().whereType<File>()) {
        file.writeAsStringSync('not json');
      }
      expect(await store.get('a'), isNull);
    });
  });
}
