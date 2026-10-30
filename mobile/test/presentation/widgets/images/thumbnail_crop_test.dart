import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/presentation/widgets/images/image_provider.dart';
import 'package:immich_mobile/presentation/widgets/images/local_image_provider.dart';
import 'package:immich_mobile/presentation/widgets/images/remote_image_provider.dart';

import '../../../unit/presentation/presentation_context.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late PresentationContext context;

  setUp(() async => context = await PresentationContext.create());
  tearDown(() async => context.dispose());

  const tile = Size(180, 180);

  test('long screenshots and panoramas are long for a square tile; photos are not', () {
    expect(isLongForTile(1080, 20000, tile), isTrue);
    expect(isLongForTile(6336, 2832, tile), isTrue);
    expect(isLongForTile(4032, 3024, tile), isFalse);
    expect(isLongForTile(1080, 2160, tile), isFalse);
    expect(isLongForTile(null, 100, tile), isFalse);
  });

  LocalAsset local(int width, int height) => LocalAsset(
    id: 'local',
    name: 'image.jpg',
    type: AssetType.image,
    createdAt: DateTime(2026),
    updatedAt: DateTime(2026),
    width: width,
    height: height,
    playbackStyle: AssetPlaybackStyle.image,
    isEdited: false,
  );

  RemoteAsset remote(int width, int height) => RemoteAsset(
    id: 'remote',
    name: 'image.png',
    ownerId: 'owner',
    checksum: 'checksum',
    type: AssetType.image,
    createdAt: DateTime(2026),
    updatedAt: DateTime(2026),
    width: width,
    height: height,
    isEdited: false,
  );

  test('a tile asks for the middle of a long image only', () {
    final long = getThumbnailImageProvider(local(1080, 20000), crop: true)! as LocalThumbProvider;
    expect(long.crop, isTrue);
    final photo = getThumbnailImageProvider(local(4032, 3024), crop: true)! as LocalThumbProvider;
    expect(photo.crop, isFalse);
    // the same thumbnail as the viewer shows while the photo loads
    expect(photo, getThumbnailImageProvider(local(4032, 3024)));

    final remoteLong =
        getThumbnailImageProvider(remote(1080, 20000), remoteSize: tile, crop: true)! as RemoteImageProvider;
    expect(remoteLong.crop, isTrue);
    expect(remoteLong.decodeSize, tile);
  });
}
