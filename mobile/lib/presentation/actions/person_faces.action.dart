import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/constants/enums.dart';
import 'package:immich_mobile/data/store.dart';
import 'package:immich_mobile/domain/models/person.model.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/presentation/actions/action.dart';
import 'package:immich_mobile/presentation/widgets/people/person_picker.widget.dart';
import 'package:immich_mobile/providers/infrastructure/toast.provider.dart';
import 'package:immich_mobile/utils/error_handler.dart';
import 'package:immich_mobile/widgets/common/confirm_dialog.dart';

final _stateProvider = Provider.family.autoDispose<List<String>?, ActionSource>((ref, source) {
  final assets = ref.watch(assetsActionProvider(source));
  final assetIds = assets.remote().map((asset) => asset.id).toList(growable: false);
  return assetIds.isEmpty ? null : assetIds;
}, dependencies: [assetsActionProvider]);

/// The selected photos are not [person]: its faces in them leave it for good (facial recognition never gives them to it
/// again)
class NotThisPersonAction extends AssetActionBuilder {
  final Person person;

  const NotThisPersonAction({required super.source, required this.person});

  @override
  ActionItem? create(BuildContext context, WidgetRef ref) {
    final assetIds = ref.watch(_stateProvider(source));
    if (assetIds == null) {
      return null;
    }

    return .new(
      icon: Icons.person_remove_outlined,
      label: context.t.not_this_person,
      onAction: () => rejectFaces(
        context,
        ref,
        person: person,
        assetIds: assetIds,
        onDone: ref.read(clearSelectionProvider(source)),
      ),
    );
  }
}

/// The selected photos are someone else: the faces of [person] in them go to the person the user picks
class MoveToPersonAction extends AssetActionBuilder {
  final Person person;

  const MoveToPersonAction({required super.source, required this.person});

  @override
  ActionItem? create(BuildContext context, WidgetRef ref) {
    final assetIds = ref.watch(_stateProvider(source));
    if (assetIds == null) {
      return null;
    }

    return .new(
      icon: Icons.switch_account_outlined,
      label: context.t.fix_incorrect_match,
      onAction: () =>
          moveFaces(context, ref, person: person, assetIds: assetIds, onDone: ref.read(clearSelectionProvider(source))),
    );
  }
}

String _nameOf(BuildContext context, Person person) => person.name.isEmpty ? context.t.this_person : person.name;

/// Asks, then says the faces of [person] in [assetIds] are not this person
Future<void> rejectFaces(
  BuildContext context,
  WidgetRef ref, {
  required Person person,
  required List<String> assetIds,
  VoidCallback? onDone,
}) async {
  final name = _nameOf(context, person);
  final confirmed = await showDialog<bool>(
    context: context,
    builder: (_) => ConfirmDialog(
      title: context.t.not_this_person,
      content: context.t.not_this_person_confirm(count: assetIds.length, name: name),
      ok: context.t.not_this_person,
    ),
  );
  if (confirmed != true || !context.mounted) {
    return;
  }

  final toastService = ref.read(toastServiceProvider);
  final message = context.t.not_this_person_count(count: assetIds.length, name: name);
  try {
    await ref.read(Store.people).rejectFaces(person.id, assetIds);
    toastService.success(message);
    onDone?.call();
  } catch (error, stack) {
    handleError(error, stack: stack, description: 'Failed to take the faces from the person');
  }
}

/// Lets the user pick who the faces of [person] in [assetIds] are, an existing person or a new one, and moves them
Future<void> moveFaces(
  BuildContext context,
  WidgetRef ref, {
  required Person person,
  required List<String> assetIds,
  VoidCallback? onDone,
}) async {
  final picked = await showPersonPicker(context, exclude: person.id);
  if (picked == null || !context.mounted) {
    return;
  }

  final toastService = ref.read(toastServiceProvider);
  final people = ref.read(Store.people);
  try {
    final target = switch (picked) {
      PickedPerson(:final person) => person,
      NewPerson(:final name) => await people.moveFacesToNewPerson(person.id, name, assetIds),
    };
    if (picked is PickedPerson) {
      await people.moveFaces(person.id, target.id, assetIds);
    }
    if (context.mounted) {
      toastService.success(context.t.faces_moved_to_person(count: assetIds.length, name: _nameOf(context, target)));
    }
    onDone?.call();
  } catch (error, stack) {
    handleError(error, stack: stack, description: 'Failed to move the faces to another person');
  }
}
