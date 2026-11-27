import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/providers/infrastructure/platform.provider.dart';
import 'package:immich_mobile/repositories/network.repository.dart';
import 'package:immich_mobile/repositories/permission.repository.dart';

final networkServiceProvider = Provider((ref) {
  return NetworkService(ref.watch(networkRepositoryProvider), ref.watch(permissionRepositoryProvider));
});

class NetworkService {
  final NetworkRepository _repository;
  final DevicePermissionRepository _permissionRepository;

  const NetworkService(this._repository, this._permissionRepository);

  Future<bool> getLocationWhenInUserPermission() {
    return _permissionRepository.hasLocationWhenInUsePermission();
  }

  Future<bool> requestLocationWhenInUsePermission() {
    return _permissionRepository.requestLocationWhenInUsePermission();
  }

  Future<bool> getLocationAlwaysPermission() {
    return _permissionRepository.hasLocationAlwaysPermission();
  }

  Future<bool> requestLocationAlwaysPermission() {
    return _permissionRepository.requestLocationAlwaysPermission();
  }

  Future<String?> getWifiName() async {
    final canRead = await getLocationWhenInUserPermission();
    if (!canRead) {
      return null;
    }

    return await _repository.getWifiName();
  }

  /// Trust the key [pin] for the HTTPS server [serverUrl] instead of certificate authorities (self-signed mode, from
  /// the QR code that signs the phone in); nulls: no such server
  Future<void> setPinnedServer(String? serverUrl, String? pin) {
    return networkApi.setPinnedServer(serverUrl, pin);
  }

  Future<bool> openSettings() {
    return _permissionRepository.openSettings();
  }
}
