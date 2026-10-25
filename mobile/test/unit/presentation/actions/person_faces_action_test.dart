import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/data/store.dart';
import 'package:immich_mobile/data/store/person.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/person.model.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/presentation/actions/action.widget.dart';
import 'package:immich_mobile/presentation/actions/person_faces.action.dart';
import 'package:immich_mobile/providers/infrastructure/toast.provider.dart';
import 'package:immich_ui/immich_ui.dart';
import 'package:mocktail/mocktail.dart';

import '../../factories/local_asset_factory.dart';
import '../../factories/remote_asset_factory.dart';
import '../presentation_context.dart';

class _MockPersonMutations extends Mock implements PersonMutations {}

void main() {
  const grandma = Person(id: 'grandma', name: 'Grandma');
  const aunt = Person(id: 'aunt', name: 'Aunt');

  late PresentationContext context;
  late _MockPersonMutations people;

  setUp(() async {
    context = await PresentationContext.create();
    people = _MockPersonMutations();
    when(() => people.rejectFaces(any(), any())).thenAnswer((_) async => 1);
    when(() => people.moveFaces(any(), any(), any())).thenAnswer((_) async => 1);
  });

  tearDown(() async {
    await context.dispose();
  });

  List<Override> overrides(Set<BaseAsset> selection) => [
    ...context.selected(selection),
    toastServiceProvider.overrideWithValue(context.service.toast),
    Store.people.overrideWithValue(people),
    Store.people.all().overrideWith((ref) => Stream.value(const [grandma, aunt])),
  ];

  group('NotThisPersonAction', () {
    testWidgets('takes the faces of the person in the selected photos, once confirmed', (tester) async {
      final [first, second] = [RemoteAssetFactory.create(), RemoteAssetFactory.create()];

      await tester.pumpTestAction(
        context,
        const NotThisPersonAction(source: .timeline, person: grandma),
        overrides: overrides({first, second}),
      );
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.text(StaticTranslations.instance.not_this_person_confirm(count: 2, name: 'Grandma')), findsOneWidget);
      await tester.tap(find.widgetWithText(TextButton, StaticTranslations.instance.not_this_person));
      await tester.pumpAndSettle();

      verify(() => people.rejectFaces('grandma', [first.id, second.id])).called(1);
      final message = verify(() => context.service.toast.success(captureAny())).captured.single as String;
      expect(message, StaticTranslations.instance.not_this_person_count(count: 2, name: 'Grandma'));
    });

    testWidgets('does nothing when the user cancels', (tester) async {
      await tester.pumpTestAction(
        context,
        const NotThisPersonAction(source: .timeline, person: grandma),
        overrides: overrides({RemoteAssetFactory.create()}),
      );
      await tester.pump(const Duration(milliseconds: 300));
      await tester.tap(find.widgetWithText(TextButton, StaticTranslations.instance.cancel));
      await tester.pumpAndSettle();

      verifyNever(() => people.rejectFaces(any(), any()));
    });

    testWidgets('is hidden for photos only on the phone', (tester) async {
      await tester.pumpTestWidget(
        context,
        const ActionIconButton(
          action: NotThisPersonAction(source: .timeline, person: grandma),
        ),
        overrides: overrides({LocalAssetFactory.create()}),
      );

      expect(find.byType(ImmichIconButton), findsNothing);
    });
  });

  group('MoveToPersonAction', () {
    testWidgets('gives the faces to the person picked, without the person they are taken from', (tester) async {
      final asset = RemoteAssetFactory.create();

      await tester.pumpTestAction(
        context,
        const MoveToPersonAction(source: .timeline, person: grandma),
        overrides: overrides({asset}),
      );
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.widgetWithText(ListTile, 'Grandma'), findsNothing);
      await tester.tap(find.widgetWithText(ListTile, 'Aunt'));
      await tester.pump(const Duration(milliseconds: 300));

      verify(() => people.moveFaces('grandma', 'aunt', [asset.id])).called(1);
    });

    testWidgets('gives the faces to someone new, named by the search', (tester) async {
      final asset = RemoteAssetFactory.create();
      when(
        () => people.moveFacesToNewPerson(any(), any(), any()),
      ).thenAnswer((_) async => const Person(id: 'new', name: 'Uncle'));

      await tester.pumpTestAction(
        context,
        const MoveToPersonAction(source: .timeline, person: grandma),
        overrides: overrides({asset}),
      );
      await tester.pump(const Duration(milliseconds: 300));
      await tester.enterText(find.byKey(const Key('person-picker-search')), 'Uncle');
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.widgetWithText(ListTile, 'Aunt'), findsNothing);
      await tester.tap(find.textContaining(StaticTranslations.instance.create_new_person));
      await tester.pump(const Duration(milliseconds: 300));

      verify(() => people.moveFacesToNewPerson('grandma', 'Uncle', [asset.id])).called(1);
      final message = verify(() => context.service.toast.success(captureAny())).captured.single as String;
      expect(message, StaticTranslations.instance.faces_moved_to_person(count: 1, name: 'Uncle'));
    });
  });
}
