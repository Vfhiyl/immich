import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/data/server/person.dart';
import 'package:immich_mobile/data/store.dart';
import 'package:immich_mobile/domain/models/person.model.dart';
import 'package:immich_mobile/domain/models/user.model.dart';
import 'package:immich_mobile/domain/services/user.service.dart';
import 'package:immich_mobile/providers/infrastructure/db.provider.dart';
import 'package:immich_mobile/providers/user.provider.dart';
import 'package:mocktail/mocktail.dart';

import '../../medium/repository_context.dart';

class _MockPersonApi extends Mock implements PersonApiRepository {}

class _MockUserService extends Mock implements UserService {}

// the corrections of faces in the app: pushed to the server, and applied to the local database at once
void main() {
  late MediumRepositoryContext ctx;
  late _MockPersonApi api;
  late ProviderContainer container;
  late String ownerId;

  setUp(() async {
    ctx = MediumRepositoryContext();
    api = _MockPersonApi();
    ownerId = (await ctx.newUser()).id;
    final users = _MockUserService();
    when(
      () => users.tryGetMyUser(),
    ).thenReturn(UserDto(id: ownerId, email: 'user@test.dev', name: 'user', profileChangedAt: DateTime(2026)));
    when(() => users.watchMyUser()).thenAnswer((_) => const Stream.empty());
    container = ProviderContainer(
      overrides: [
        driftProvider.overrideWithValue(ctx.db),
        personApiRepositoryProvider.overrideWithValue(api),
        currentUserProvider.overrideWith((ref) => CurrentUserProvider(users)),
        Store.userMetadata.preferences().overrideWith((ref) => Stream.value(null)),
      ],
    );
    addTearDown(container.dispose);
    addTearDown(ctx.dispose);
  });

  Future<List<String?>> peopleOf(List<String> faceIds) async {
    final rows = await (ctx.db.select(ctx.db.assetFaceEntity)..where((row) => row.id.isIn(faceIds))).get();
    final byId = {for (final row in rows) row.id: row.personId};
    return [for (final id in faceIds) byId[id]];
  }

  test('not this person takes the faces of the person in the photos, and only those', () async {
    final [first, second] = [await ctx.newRemoteAsset(ownerId: ownerId), await ctx.newRemoteAsset(ownerId: ownerId)];
    final person = await ctx.newPerson(ownerId: ownerId, name: 'Grandma');
    final other = await ctx.newPerson(ownerId: ownerId, name: 'Other');
    final taken = await ctx.newFace(assetId: first.id, personId: person.id);
    final kept = await ctx.newFace(assetId: second.id, personId: person.id);
    final someoneElse = await ctx.newFace(assetId: first.id, personId: other.id);
    when(() => api.rejectFaces(person.id, [first.id])).thenAnswer((_) async {});

    await container.read(Store.people).rejectFaces(person.id, [first.id]);

    verify(() => api.rejectFaces(person.id, [first.id])).called(1);
    expect(await peopleOf([taken.id, kept.id, someoneElse.id]), [null, person.id, other.id]);
    expect((await container.read(Store.people.forAsset(first.id).future)).map((p) => p.id), [other.id]);
  });

  test('a failed request changes nothing here', () async {
    final asset = await ctx.newRemoteAsset(ownerId: ownerId);
    final person = await ctx.newPerson(ownerId: ownerId);
    final face = await ctx.newFace(assetId: asset.id, personId: person.id);
    when(() => api.rejectFaces(person.id, [asset.id])).thenThrow(Exception('offline'));

    await expectLater(container.read(Store.people).rejectFaces(person.id, [asset.id]), throwsException);

    expect(await peopleOf([face.id]), [person.id]);
  });

  test('moving faces gives them to the person picked', () async {
    final asset = await ctx.newRemoteAsset(ownerId: ownerId);
    final [wrong, right] = [await ctx.newPerson(ownerId: ownerId), await ctx.newPerson(ownerId: ownerId)];
    final face = await ctx.newFace(assetId: asset.id, personId: wrong.id);
    when(() => api.moveFaces(wrong.id, right.id, [asset.id])).thenAnswer((_) async {});

    await container.read(Store.people).moveFaces(wrong.id, right.id, [asset.id]);

    verify(() => api.moveFaces(wrong.id, right.id, [asset.id])).called(1);
    expect(await peopleOf([face.id]), [right.id]);
  });

  test('moving faces to someone new creates the person, shown here before the next sync', () async {
    final asset = await ctx.newRemoteAsset(ownerId: ownerId);
    final wrong = await ctx.newPerson(ownerId: ownerId);
    final face = await ctx.newFace(assetId: asset.id, personId: wrong.id);
    const created = Person(id: 'new-person', name: 'Aunt');
    when(() => api.create('Aunt')).thenAnswer((_) async => created);
    when(() => api.moveFaces(wrong.id, created.id, [asset.id])).thenAnswer((_) async {});

    final person = await container.read(Store.people).moveFacesToNewPerson(wrong.id, 'Aunt', [asset.id]);

    expect(person.id, created.id);
    expect(await peopleOf([face.id]), [created.id]);
    expect((await container.read(Store.people.forAsset(asset.id).future)).map((p) => p.name), ['Aunt']);
  });
}
