import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/data/server/api_repository.dart';
import 'package:immich_mobile/domain/models/person.model.dart';
import 'package:immich_mobile/providers/api.provider.dart';
import 'package:openapi/api.dart';

final personApiRepositoryProvider = Provider((ref) => PersonApiRepository(ref.watch(apiServiceProvider).peopleApi));

class PersonApiRepository extends ApiRepository {
  final PeopleApi _api;

  const PersonApiRepository(this._api);

  Future<Person> update(String id, {String? name, DateTime? birthday}) async {
    final birthdayUtc = birthday == null ? null : DateTime.utc(birthday.year, birthday.month, birthday.day);
    final dto = PersonUpdateDto(
      name: name == null ? const Optional.absent() : Optional.present(name),
      birthDate: birthdayUtc == null ? const Optional.absent() : Optional.present(birthdayUtc),
    );
    final response = await checkNull(_api.updatePerson(id, dto));
    return _toPerson(response);
  }

  /// The faces of the person in the photos are not this person: they leave it, and facial recognition never gives
  /// them to it again
  Future<void> rejectFaces(String personId, List<String> assetIds) =>
      _api.rejectFacesOfPerson(personId, AssetIdsDto(assetIds: assetIds));

  /// The faces of the person in the photos are another person
  Future<void> moveFaces(String fromPersonId, String toPersonId, List<String> assetIds) => _api.reassignFaces(
    toPersonId,
    AssetFaceUpdateDto(
      data: [for (final assetId in assetIds) AssetFaceUpdateItem(assetId: assetId, personId: fromPersonId)],
    ),
  );

  Future<Person> create(String name) async {
    final response = await checkNull(_api.createPerson(PersonCreateDto(name: Optional.present(name))));
    return _toPerson(response);
  }

  static Person _toPerson(PersonResponseDto dto) =>
      .new(birthDate: dto.birthDate, id: dto.id, name: dto.name, updatedAt: dto.updatedAt.orElse(null));
}
