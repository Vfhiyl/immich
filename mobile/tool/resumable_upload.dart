// Uploads a file with the resumable upload client of the app, outside the app: the end-to-end tests of the server run
// it, so that the client and the server are tested together.
//
// usage: dart run tool/resumable_upload.dart <api endpoint> <access token> <file> [--cut-after <bytes>] [--part-size <bytes>]
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart';
import 'package:http/io_client.dart';
import 'package:immich_mobile/infrastructure/repositories/resumable_upload.repository.dart';

/// Cuts the connection of the first part request after some bytes, as a dropped network would
class _CuttingClient extends BaseClient {
  final Client _inner;
  int? _cutAfter;

  _CuttingClient(this._inner, this._cutAfter);

  @override
  Future<StreamedResponse> send(BaseRequest request) {
    final cutAfter = _cutAfter;
    if (cutAfter == null || request.method != 'PATCH' || request is! StreamedRequest) {
      return _inner.send(request);
    }
    _cutAfter = null;
    final cut = StreamedRequest(request.method, request.url)
      ..headers.addAll(request.headers)
      ..contentLength = request.contentLength;
    var sent = 0;
    request.finalize().listen((chunk) {
      if (sent >= cutAfter) {
        return;
      }
      final part = chunk.length > cutAfter - sent ? chunk.sublist(0, cutAfter - sent) : chunk;
      sent += part.length;
      cut.sink.add(part);
      if (sent >= cutAfter) {
        cut.sink.addError(const SocketException('cut off by the test'));
      }
    }, onDone: () {});
    return _inner.send(cut);
  }
}

Future<void> main(List<String> args) async {
  if (args.length < 3) {
    stderr.writeln('usage: resumable_upload.dart <api endpoint> <access token> <file> [--cut-after <bytes>]');
    exit(2);
  }
  final [endpoint, token, path, ...rest] = args;
  int? option(String name) {
    final index = rest.indexOf(name);
    return index == -1 ? null : int.parse(rest[index + 1]);
  }

  final file = File(path);
  final client = _CuttingClient(IOClient(), option('--cut-after'));
  final sut = ResumableUploadRepository(client, InMemoryResumableUploadSessionStore());
  final headers = {'Authorization': 'Bearer $token'};
  final options = await sut.getOptions(endpoint, headers: headers);
  if (options == null) {
    stdout.writeln(jsonEncode({'result': 'unsupported'}));
    exit(1);
  }
  final partSize = option('--part-size');

  final modified = file.lastModifiedSync().toUtc().toIso8601String();
  final outcome = await sut.upload(
    endpoint: endpoint,
    file: file,
    assetData: {'filename': file.uri.pathSegments.last, 'fileCreatedAt': modified, 'fileModifiedAt': modified},
    headers: headers,
    sessionKey: path,
    options: partSize == null ? options : ResumableUploadOptions(maxAppendSize: partSize),
  );
  stdout.writeln(
    jsonEncode(switch (outcome) {
      ResumableUploadSucceeded(:final assetId, :final isDuplicate) => {
        'result': isDuplicate ? 'duplicate' : 'created',
        'id': assetId,
      },
      ResumableUploadFailed(:final message, :final statusCode) => {
        'result': 'failed',
        'message': message,
        'status': statusCode,
      },
      ResumableUploadCancelled() => {'result': 'cancelled'},
    }),
  );
  client.close();
  exit(outcome is ResumableUploadSucceeded ? 0 : 1);
}
