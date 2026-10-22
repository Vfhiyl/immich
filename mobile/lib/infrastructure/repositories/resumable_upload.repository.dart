import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:http/http.dart';
import 'package:logging/logging.dart';

/// What a server that takes resumable uploads (draft-ietf-httpbis-resumable-upload) allows, from `OPTIONS /upload`
class ResumableUploadOptions {
  /// The largest request body the server (or a proxy before it) takes; null for no limit
  final int? maxAppendSize;

  const ResumableUploadOptions({this.maxAppendSize});

  /// Parses `Upload-Limit` (a structured field dictionary, e.g. `min-size=0, max-append-size=100000000, max-age=86400`)
  static ResumableUploadOptions? fromHeaders(Map<String, String> headers) {
    final limit = headers['upload-limit'];
    if (limit == null) {
      return null;
    }
    int? maxAppendSize;
    for (final member in limit.split(',')) {
      final [name, ...value] = member.trim().split('=');
      if (name == 'max-append-size' && value.isNotEmpty) {
        maxAppendSize = int.tryParse(value.first);
      }
    }
    return ResumableUploadOptions(maxAppendSize: maxAppendSize);
  }
}

/// An upload the server knows, kept so that it can be resumed, also after the app was stopped
class ResumableUploadSession {
  final String location;
  final int size;
  final String sha1;

  const ResumableUploadSession({required this.location, required this.size, required this.sha1});

  Map<String, Object> toJson() => {'location': location, 'size': size, 'sha1': sha1};

  static ResumableUploadSession? fromJson(Object? json) {
    if (json is! Map || json['location'] is! String || json['size'] is! int || json['sha1'] is! String) {
      return null;
    }
    return ResumableUploadSession(
      location: json['location'] as String,
      size: json['size'] as int,
      sha1: json['sha1'] as String,
    );
  }
}

/// Where uploads in progress are kept, by a key of the caller (e.g. the local asset)
abstract interface class ResumableUploadSessionStore {
  FutureOr<ResumableUploadSession?> get(String key);
  FutureOr<void> put(String key, ResumableUploadSession session);
  FutureOr<void> remove(String key);
}

/// Uploads in progress as files in a folder, one per upload, each written at once: uploads that run at the same time,
/// also in other isolates, do not get in each other's way
class FileResumableUploadSessionStore implements ResumableUploadSessionStore {
  final Directory directory;

  FileResumableUploadSessionStore(this.directory);

  File _fileOf(String key) => File('${directory.path}/${sha1.convert(utf8.encode(key))}.json');

  @override
  Future<ResumableUploadSession?> get(String key) async {
    try {
      return ResumableUploadSession.fromJson(jsonDecode(await _fileOf(key).readAsString()));
    } on FileSystemException {
      return null;
    } on FormatException {
      return null;
    }
  }

  @override
  Future<void> put(String key, ResumableUploadSession session) async {
    await directory.create(recursive: true);
    final file = _fileOf(key);
    final temporary = File('${file.path}.${DateTime.now().microsecondsSinceEpoch}.tmp');
    await temporary.writeAsString(jsonEncode(session.toJson()), flush: true);
    await temporary.rename(file.path);
  }

  @override
  Future<void> remove(String key) async {
    try {
      await _fileOf(key).delete();
    } on FileSystemException {
      // gone already
    }
  }
}

class InMemoryResumableUploadSessionStore implements ResumableUploadSessionStore {
  final sessions = <String, ResumableUploadSession>{};

  @override
  ResumableUploadSession? get(String key) => sessions[key];

  @override
  void put(String key, ResumableUploadSession session) => sessions[key] = session;

  @override
  void remove(String key) => sessions.remove(key);
}

sealed class ResumableUploadOutcome {
  const ResumableUploadOutcome();
}

class ResumableUploadSucceeded extends ResumableUploadOutcome {
  final String assetId;

  /// Whether the server had the file already, and nothing was sent
  final bool isDuplicate;

  const ResumableUploadSucceeded(this.assetId, {this.isDuplicate = false});
}

class ResumableUploadFailed extends ResumableUploadOutcome {
  final int? statusCode;
  final String message;

  /// Whether trying again later continues where this attempt stopped
  final bool canResume;

  const ResumableUploadFailed(this.message, {this.statusCode, this.canResume = false});
}

class ResumableUploadCancelled extends ResumableUploadOutcome {
  const ResumableUploadCancelled();
}

class _Cancelled implements Exception {}

/// Uploads files to `POST /upload` of an Immich server in parts, resuming where an interrupted upload stopped: after a
/// cut connection, and after the app was stopped (the upload is kept in a [ResumableUploadSessionStore]). Only depends on
/// `dart:io` and `package:http`, so that it runs outside the app too.
class ResumableUploadRepository {
  /// Parts are at most this large, smaller if the server says so; a part that is cut off is sent again
  static const defaultPartSize = 32 * 1024 * 1024;

  /// Pauses before resuming after a request failed without an answer
  static const defaultRetryDelays = [
    Duration(seconds: 1),
    Duration(seconds: 2),
    Duration(seconds: 4),
    Duration(seconds: 8),
  ];

  final Logger _log = Logger('ResumableUploadRepository');
  final Client _client;
  final ResumableUploadSessionStore _sessions;
  final List<Duration> retryDelays;

  ResumableUploadRepository(this._client, this._sessions, {this.retryDelays = defaultRetryDelays});

  /// Whether the server at [endpoint] (its API URL, ending in `/api`) takes resumable uploads, and its limits: null if
  /// it does not. Throws when the server cannot be asked, e.g. without network.
  Future<ResumableUploadOptions?> getOptions(String endpoint, {Map<String, String> headers = const {}}) async {
    final response = await _client.send(Request('OPTIONS', Uri.parse('$endpoint/upload'))..headers.addAll(headers));
    await response.stream.drain<void>();
    if (response.statusCode < 200 || response.statusCode > 299) {
      return null;
    }
    return ResumableUploadOptions.fromHeaders(response.headers);
  }

  /// The SHA-1 of a file, base64 encoded, read in a stream
  static Future<String> hashFile(File file) async {
    final digest = await sha1.bind(file.openRead()).first;
    return base64.encode(digest.bytes);
  }

  /// Upload [file] as a new asset described by [assetData] (filename, fileCreatedAt, fileModifiedAt, …). With a
  /// [sessionKey], an upload of the same content that was interrupted before is resumed.
  Future<ResumableUploadOutcome> upload({
    required String endpoint,
    required File file,
    required Map<String, Object?> assetData,
    required Map<String, String> headers,
    String? sessionKey,
    String? sha1,
    ResumableUploadOptions options = const ResumableUploadOptions(),
    Future<void>? cancel,
    void Function(int bytes, int total)? onProgress,
  }) async {
    var cancelled = false;
    unawaited(cancel?.then((_) => cancelled = true));
    void checkCancelled() {
      if (cancelled) {
        throw _Cancelled();
      }
    }

    try {
      final size = await file.length();
      final digest = sha1 ?? await hashFile(file);
      checkCancelled();
      final partSize = _partSize(options);

      var session = sessionKey == null ? null : await _sessions.get(sessionKey);
      if (session != null && (session.size != size || session.sha1 != digest)) {
        // the file changed since: its upload cannot go on
        await _sessions.remove(sessionKey!);
        session = null;
      }

      for (var attempt = 0; ; attempt++) {
        checkCancelled();
        try {
          if (session == null) {
            final created = await _create(endpoint, headers, size, digest, assetData);
            if (created is _Done) {
              return created.outcome;
            }
            session = ResumableUploadSession(location: (created as _Created).location, size: size, sha1: digest);
            if (sessionKey != null) {
              await _sessions.put(sessionKey, session);
            }
          }

          final state = await _getState(endpoint, session, headers);
          if (state == null) {
            // the server no longer knows the upload, e.g. it expired: start again
            _log.info('Upload ${session.location} is gone, starting again');
            if (sessionKey != null) {
              await _sessions.remove(sessionKey);
            }
            session = null;
            continue;
          }
          if (state.assetId != null) {
            await _forget(sessionKey);
            return ResumableUploadSucceeded(state.assetId!);
          }

          var offset = state.offset;
          while (true) {
            checkCancelled();
            onProgress?.call(offset, size);
            final end = offset + partSize < size ? offset + partSize : size;
            final result = await _append(endpoint, session, headers, file, offset, end, size, cancel, onProgress);
            if (result is _Done) {
              await _forget(sessionKey);
              return result.outcome;
            }
            offset = (result as _Appended).offset;
            // an answer arrived: the next failure gets the shortest pause again
            attempt = 0;
          }
        } on _Retry catch (error) {
          if (attempt >= retryDelays.length) {
            return ResumableUploadFailed('Upload interrupted: ${error.reason}', canResume: session != null);
          }
          _log.info('Upload interrupted (${error.reason}), resuming in ${retryDelays[attempt].inSeconds}s');
          await Future.any([Future<void>.delayed(retryDelays[attempt]), ?cancel]);
        }
      }
    } on _Cancelled {
      return const ResumableUploadCancelled();
    } on _Failed catch (error) {
      if (error.dropUpload) {
        await _forget(sessionKey);
      }
      return ResumableUploadFailed(error.message, statusCode: error.statusCode);
    }
  }

  int _partSize(ResumableUploadOptions options) {
    final limit = options.maxAppendSize;
    return limit != null && limit < defaultPartSize ? limit : defaultPartSize;
  }

  Future<void> _forget(String? sessionKey) async {
    if (sessionKey != null) {
      await _sessions.remove(sessionKey);
    }
  }

  Uri _resolve(String endpoint, String location) {
    final base = Uri.parse(endpoint);
    // the server answers with a path below its root (/api/upload/…), which the endpoint ends in
    return location.startsWith('/') ? base.replace(path: location) : base.resolve(location);
  }

  Future<_Step> _create(
    String endpoint,
    Map<String, String> headers,
    int size,
    String digest,
    Map<String, Object?> assetData,
  ) async {
    final request = Request('POST', Uri.parse('$endpoint/upload'))
      ..headers.addAll({
        ...headers,
        // the content follows in parts, so that the upload is known before any of it is sent
        'Upload-Complete': '?0',
        'Upload-Length': '$size',
        'Repr-Digest': 'sha=:$digest:',
        'X-Immich-Asset-Data': base64Url.encode(utf8.encode(jsonEncode(assetData))),
      });
    final response = await _send(request);
    final body = await _readBody(response);
    if (response.statusCode == 200) {
      // the user has this file already
      final (:id, :status) = _resultOf(body);
      return _Done(ResumableUploadSucceeded(id, isDuplicate: status == 'duplicate'));
    }
    final location = response.headers['location'];
    if (response.statusCode != 201 || location == null) {
      throw _Failed(_message(body, response.statusCode), response.statusCode);
    }
    return _Created(location);
  }

  Future<({int offset, String? assetId})?> _getState(
    String endpoint,
    ResumableUploadSession session,
    Map<String, String> headers,
  ) async {
    final response = await _send(Request('HEAD', _resolve(endpoint, session.location))..headers.addAll(headers));
    await response.stream.drain<void>();
    if (response.statusCode == 404 || response.statusCode == 410) {
      return null;
    }
    final offset = int.tryParse(response.headers['upload-offset'] ?? '');
    if (response.statusCode < 200 || response.statusCode > 299 || offset == null) {
      throw _Retry('the server answered ${response.statusCode} when asked how far the upload is');
    }
    final complete = response.headers['upload-complete'] == '?1';
    return (offset: offset, assetId: complete ? response.headers['x-immich-asset-id'] : null);
  }

  Future<_Step> _append(
    String endpoint,
    ResumableUploadSession session,
    Map<String, String> headers,
    File file,
    int offset,
    int end,
    int size,
    Future<void>? cancel,
    void Function(int bytes, int total)? onProgress,
  ) async {
    final isLast = end == size;
    final request = _AbortableStreamedRequest('PATCH', _resolve(endpoint, session.location), cancel)
      ..headers.addAll({
        ...headers,
        'Content-Type': 'application/partial-upload',
        'Upload-Offset': '$offset',
        'Upload-Complete': isLast ? '?1' : '?0',
      })
      ..contentLength = end - offset;

    var sent = offset;
    unawaited(
      file
          .openRead(offset, end)
          .map((chunk) {
            sent += chunk.length;
            onProgress?.call(sent, size);
            return chunk;
          })
          .pipe(request.sink)
          .catchError((_) {}),
    );

    final response = await _send(request);
    final body = await _readBody(response);
    switch (response.statusCode) {
      case 200 || 201 when isLast:
        return _Done(ResumableUploadSucceeded(_resultOf(body).id));
      case 204 || 200 || 201:
        final next = int.tryParse(response.headers['upload-offset'] ?? '') ?? end;
        return _Appended(next);
      case 409:
        // the server has another offset than this client thought: ask it
        throw _Retry('the offset did not match');
      case 404 || 410:
        throw _Retry('the upload is gone');
      case >= 500:
        throw _Retry('the server answered ${response.statusCode}');
      default:
        // e.g. the content did not match its SHA-1: the server dropped the upload
        throw _Failed(_message(body, response.statusCode), response.statusCode, dropUpload: true);
    }
  }

  Future<StreamedResponse> _send(BaseRequest request) async {
    try {
      return await _client.send(request);
    } on RequestAbortedException {
      throw _Cancelled();
    } on ClientException catch (error) {
      throw _Retry(error.message);
    } on SocketException catch (error) {
      throw _Retry(error.message);
    } on TimeoutException catch (error) {
      throw _Retry(error.message ?? 'timeout');
    }
  }

  Future<String> _readBody(StreamedResponse response) async {
    try {
      return await response.stream.bytesToString();
    } on ClientException catch (error) {
      throw _Retry(error.message);
    }
  }

  /// The asset an upload made, from the body of the last response
  ({String id, String? status}) _resultOf(String body) {
    final json = jsonDecode(body);
    if (json is! Map || json['id'] is! String) {
      throw _Failed('The server answered without the uploaded asset: $body', null);
    }
    return (id: json['id'] as String, status: json['status'] is String ? json['status'] as String : null);
  }

  String _message(String body, int statusCode) {
    try {
      final json = jsonDecode(body);
      if (json is Map && json['message'] is String) {
        return json['message'] as String;
      }
    } catch (_) {}
    return body.isNotEmpty ? body : 'The server answered $statusCode';
  }
}

sealed class _Step {}

class _Created extends _Step {
  final String location;
  _Created(this.location);
}

class _Appended extends _Step {
  final int offset;
  _Appended(this.offset);
}

class _Done extends _Step {
  final ResumableUploadOutcome outcome;
  _Done(this.outcome);
}

class _Retry implements Exception {
  final String reason;
  _Retry(this.reason);
}

class _Failed implements Exception {
  final String message;
  final int? statusCode;
  final bool dropUpload;
  _Failed(this.message, this.statusCode, {this.dropUpload = false});
}

class _AbortableStreamedRequest extends StreamedRequest with Abortable {
  _AbortableStreamedRequest(super.method, super.url, this.abortTrigger);

  @override
  final Future<void>? abortTrigger;
}
