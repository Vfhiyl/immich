import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart';
import 'package:http/testing.dart';

class FakeUpload {
  final List<int> received = [];
  final int length;
  final String digest;
  final Map<String, Object?> assetData;
  String? assetId;

  FakeUpload(this.length, this.digest, this.assetData);
}

/// The server side of resumable uploads as Immich implements it, in memory
class FakeResumableUploadServer {
  final uploads = <String, FakeUpload>{};
  final requests = <String>[];
  final existingChecksums = <String, String>{};
  int? maxAppendSize;
  bool supportsUploads = true;

  /// Bytes after which the next part request is cut off, as a dropped connection would
  int? cutAfter;

  /// Answer the next part with this status instead
  int? failNextPart;

  late final client = MockClient.streaming((request, body) async {
    final bytes = await body.toBytes();
    final path = request.url.path;
    requests.add('${request.method} $path');

    if (request.method == 'OPTIONS') {
      if (!supportsUploads) {
        return StreamedResponse(Stream.value([]), 404);
      }
      final limit = ['min-size=0', if (maxAppendSize != null) 'max-append-size=$maxAppendSize', 'max-age=86400'];
      return StreamedResponse(Stream.value([]), 204, headers: {'upload-limit': limit.join(', ')});
    }

    if (request.method == 'POST' && path == '/api/upload') {
      final digest = RegExp(r'sha=:(.*):').firstMatch(request.headers['repr-digest']!)!.group(1)!;
      final existing = existingChecksums[digest];
      if (existing != null) {
        return _json(200, {'id': existing, 'status': 'duplicate'});
      }
      final assetData = jsonDecode(utf8.decode(base64Url.decode(request.headers['x-immich-asset-data']!)));
      final id = 'upload-${uploads.length + 1}';
      uploads[id] = FakeUpload(int.parse(request.headers['upload-length']!), digest, assetData as Map<String, Object?>);
      return StreamedResponse(Stream.value([]), 201, headers: {'location': '/api/upload/$id'});
    }

    final upload = uploads[path.split('/').last];
    if (upload == null) {
      return StreamedResponse(Stream.value([]), 404);
    }

    if (request.method == 'HEAD') {
      return StreamedResponse(
        Stream.value([]),
        204,
        headers: {
          'upload-offset': '${upload.received.length}',
          'upload-complete': upload.assetId == null ? '?0' : '?1',
          if (upload.assetId != null) 'x-immich-asset-id': upload.assetId!,
        },
      );
    }

    if (request.method == 'PATCH') {
      expect(request.headers['content-type'], 'application/partial-upload');
      final offset = int.parse(request.headers['upload-offset']!);
      if (offset != upload.received.length) {
        return StreamedResponse(Stream.value([]), 409, headers: {'upload-offset': '${upload.received.length}'});
      }
      if (failNextPart != null) {
        final status = failNextPart!;
        failNextPart = null;
        return _json(status, {'message': 'The part failed'});
      }
      if (cutAfter != null && bytes.length > cutAfter!) {
        upload.received.addAll(bytes.sublist(0, cutAfter));
        cutAfter = null;
        throw ClientException('Connection reset by peer');
      }
      upload.received.addAll(bytes);
      if (request.headers['upload-complete'] == '?1') {
        final digest = base64.encode(sha1.convert(upload.received).bytes);
        if (digest != upload.digest || upload.received.length != upload.length) {
          return _json(400, {'message': 'The uploaded file does not match its declared SHA-1'});
        }
        upload.assetId = 'asset-${path.split('/').last}';
        return _json(200, {'id': upload.assetId, 'status': 'created'});
      }
      return StreamedResponse(Stream.value([]), 204, headers: {'upload-offset': '${upload.received.length}'});
    }

    return StreamedResponse(Stream.value([]), 405);
  });

  StreamedResponse _json(int status, Map<String, Object?> body) => StreamedResponse(
    Stream.value(utf8.encode(jsonEncode(body))),
    status,
    headers: {'content-type': 'application/json'},
  );
}
