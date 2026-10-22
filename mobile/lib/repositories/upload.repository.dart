import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:background_downloader/background_downloader.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:http/http.dart';
import 'package:immich_mobile/constants/constants.dart';
import 'package:immich_mobile/domain/models/store.model.dart';
import 'package:immich_mobile/entities/store.entity.dart';
import 'package:immich_mobile/infrastructure/repositories/network.repository.dart';
import 'package:immich_mobile/infrastructure/repositories/resumable_upload.repository.dart';
import 'package:logging/logging.dart';
import 'package:path_provider/path_provider.dart';

final uploadRepositoryProvider = Provider((ref) => UploadRepository());

class UploadRepository {
  final Logger logger = Logger('UploadRepository');
  ResumableUploadSessionStore? _resumableSessions;
  void Function(TaskStatusUpdate)? onUploadStatus;
  void Function(TaskProgressUpdate)? onTaskProgress;

  UploadRepository({this._resumableSessions}) {
    FileDownloader().registerCallbacks(
      group: kBackupGroup,
      taskStatusCallback: (update) => onUploadStatus?.call(update),
      taskProgressCallback: (update) => onTaskProgress?.call(update),
    );
    FileDownloader().registerCallbacks(
      group: kBackupLivePhotoGroup,
      taskStatusCallback: (update) => onUploadStatus?.call(update),
      taskProgressCallback: (update) => onTaskProgress?.call(update),
    );
    FileDownloader().registerCallbacks(
      group: kManualUploadGroup,
      taskStatusCallback: (update) => onUploadStatus?.call(update),
      taskProgressCallback: (update) => onTaskProgress?.call(update),
    );
  }

  Future<List<bool>> enqueueBackgroundAll(List<UploadTask> tasks) {
    return FileDownloader().enqueueAll(tasks);
  }

  Future<void> deleteDatabaseRecords(String group) {
    return FileDownloader().database.deleteAllRecords(group: group);
  }

  Future<int> reset(String group) {
    return FileDownloader().reset(group: group);
  }

  /// Get a list of tasks that are ENQUEUED or RUNNING
  Future<List<Task>> getActiveTasks(String group) {
    return FileDownloader().allTasks(group: group);
  }

  Future<void> start() {
    return FileDownloader().start();
  }

  /// Upload a file as a new asset. With a [resumeKey] (which identifies the file to upload, e.g. by its local asset), the
  /// file is uploaded in parts when the server takes resumable uploads, and an interrupted upload continues where it
  /// stopped, also after the app was stopped; otherwise it is sent in one request.
  Future<UploadResult> uploadFile({
    required File file,
    required String originalFileName,
    required Map<String, String> fields,
    required Completer<void>? cancelToken,
    void Function(int bytes, int totalBytes)? onProgress,
    required String logContext,
    Client? httpClient,
    String? resumeKey,
  }) async {
    final String savedEndpoint = Store.get(StoreKey.serverEndpoint);
    final client = httpClient ?? NetworkRepository.client;

    if (resumeKey != null) {
      final options = await _getResumableUploadOptions(savedEndpoint, client);
      if (options != null) {
        return _uploadResumable(
          client: client,
          endpoint: savedEndpoint,
          file: file,
          originalFileName: originalFileName,
          fields: fields,
          options: options,
          resumeKey: resumeKey,
          cancelToken: cancelToken,
          onProgress: onProgress,
          logContext: logContext,
        );
      }
    }

    ProgressMultipartRequest buildRequest() {
      final request = ProgressMultipartRequest(
        'POST',
        Uri.parse('$savedEndpoint/assets'),
        abortTrigger: cancelToken?.future,
        onProgress: onProgress,
      );
      request.fields.addAll(fields);
      request.files.add(MultipartFile("assetData", file.openRead(), file.lengthSync(), filename: originalFileName));
      return request;
    }

    try {
      StreamedResponse response;
      try {
        response = await client.send(buildRequest());
      } on RequestAbortedException {
        rethrow;
      } on ClientException catch (error) {
        logger.warning("Upload $logContext failed before a response, resending once: $error");
        response = await client.send(buildRequest());
      }

      final responseBodyString = await response.stream.bytesToString();

      if (![200, 201].contains(response.statusCode)) {
        String? errorMessage;

        if (response.statusCode == 413) {
          errorMessage = 'Error(413) File is too large to upload';
          return UploadResult.error(statusCode: response.statusCode, errorMessage: errorMessage);
        }

        try {
          final error = jsonDecode(responseBodyString);
          errorMessage = error['message'] ?? error['error'];
        } catch (_) {
          errorMessage = responseBodyString.isNotEmpty
              ? responseBodyString
              : 'Upload failed with status ${response.statusCode}';
        }

        return UploadResult.error(statusCode: response.statusCode, errorMessage: errorMessage);
      }

      try {
        final responseBody = jsonDecode(responseBodyString);
        return UploadResult.success(remoteAssetId: responseBody['id'] as String);
      } catch (e) {
        return UploadResult.error(errorMessage: 'Failed to parse server response');
      }
    } on RequestAbortedException {
      logger.warning("Upload $logContext was cancelled");
      return UploadResult.cancelled();
    } catch (error, stackTrace) {
      logger.warning("Error uploading $logContext: $error: $stackTrace");
      return UploadResult.error(errorMessage: error.toString());
    }
  }

  /// What servers allow for resumable uploads, by endpoint, as they answered (null: they do not take them)
  static final _resumableUploadOptions = <String, ResumableUploadOptions?>{};

  Future<ResumableUploadOptions?> _getResumableUploadOptions(String endpoint, Client client) async {
    if (_resumableUploadOptions.containsKey(endpoint)) {
      return _resumableUploadOptions[endpoint];
    }
    try {
      final options = await ResumableUploadRepository(client, await _getResumableSessions()).getOptions(endpoint);
      return _resumableUploadOptions[endpoint] = options;
    } catch (error) {
      // asked again next time; the upload in one request below fails the same way, or succeeds
      logger.warning("Unable to learn whether the server takes resumable uploads: $error");
      return null;
    }
  }

  /// Uploads in progress, kept with the app so that they are resumed after it was stopped
  Future<ResumableUploadSessionStore> _getResumableSessions() async => _resumableSessions ??=
      FileResumableUploadSessionStore(Directory('${(await getApplicationSupportDirectory()).path}/resumable-uploads'));

  /// The server may have been upgraded or replaced: ask it again
  static void forgetResumableUploadOptions() => _resumableUploadOptions.clear();

  Future<UploadResult> _uploadResumable({
    required Client client,
    required String endpoint,
    required File file,
    required String originalFileName,
    required Map<String, String> fields,
    required ResumableUploadOptions options,
    required String resumeKey,
    required Completer<void>? cancelToken,
    required void Function(int bytes, int totalBytes)? onProgress,
    required String logContext,
  }) async {
    final outcome = await ResumableUploadRepository(client, await _getResumableSessions()).upload(
      endpoint: endpoint,
      file: file,
      assetData: toResumableAssetData(originalFileName, fields),
      // the native clients of the app add authentication
      headers: const {},
      sessionKey: resumeKey,
      options: options,
      cancel: cancelToken?.future,
      onProgress: onProgress,
    );
    switch (outcome) {
      case ResumableUploadSucceeded(:final assetId):
        return UploadResult.success(remoteAssetId: assetId);
      case ResumableUploadCancelled():
        logger.warning("Upload $logContext was cancelled");
        return UploadResult.cancelled();
      case ResumableUploadFailed(:final message, :final statusCode, :final canResume):
        logger.warning("Upload $logContext failed${canResume ? ', it is resumed next time' : ''}: $message");
        return UploadResult.error(statusCode: statusCode, errorMessage: message);
    }
  }
}

/// What describes an asset in a resumable upload, from the form fields of an upload in one request
Map<String, Object?> toResumableAssetData(String originalFileName, Map<String, String> fields) {
  final metadata = fields['metadata'];
  return {
    'filename': originalFileName,
    'fileCreatedAt': fields['fileCreatedAt'],
    'fileModifiedAt': fields['fileModifiedAt'],
    if (fields['deviceAssetId'] != null) 'deviceAssetId': fields['deviceAssetId'],
    if (fields['deviceId'] != null) 'deviceId': fields['deviceId'],
    if (int.tryParse(fields['duration'] ?? '') != null) 'duration': int.parse(fields['duration']!),
    if (fields['isFavorite'] != null) 'isFavorite': fields['isFavorite'] == 'true',
    if (fields['visibility'] != null) 'visibility': fields['visibility'],
    if (fields['livePhotoVideoId'] != null) 'livePhotoVideoId': fields['livePhotoVideoId'],
    if (metadata != null) 'metadata': jsonDecode(metadata),
  };
}

class ProgressMultipartRequest extends MultipartRequest with Abortable {
  ProgressMultipartRequest(super.method, super.url, {this.abortTrigger, this.onProgress});

  @override
  final Future<void>? abortTrigger;

  final void Function(int bytes, int totalBytes)? onProgress;

  @override
  ByteStream finalize() {
    final byteStream = super.finalize();
    if (onProgress == null) {
      return byteStream;
    }

    final total = contentLength;
    var bytes = 0;
    final stream = byteStream.transform(
      StreamTransformer.fromHandlers(
        handleData: (List<int> data, EventSink<List<int>> sink) {
          bytes += data.length;
          onProgress!(bytes, total);
          sink.add(data);
        },
      ),
    );
    return ByteStream(stream);
  }
}

class UploadResult {
  final bool isSuccess;
  final bool isCancelled;
  final String? remoteAssetId;
  final String? errorMessage;
  final int? statusCode;

  const UploadResult({
    required this.isSuccess,
    required this.isCancelled,
    this.remoteAssetId,
    this.errorMessage,
    this.statusCode,
  });

  factory UploadResult.success({required String remoteAssetId}) {
    return UploadResult(isSuccess: true, isCancelled: false, remoteAssetId: remoteAssetId);
  }

  factory UploadResult.error({String? errorMessage, int? statusCode}) {
    return UploadResult(isSuccess: false, isCancelled: false, errorMessage: errorMessage, statusCode: statusCode);
  }

  factory UploadResult.cancelled() {
    return const UploadResult(isSuccess: false, isCancelled: true);
  }
}
