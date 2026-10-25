import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/data/store.dart';
import 'package:immich_mobile/domain/models/person.model.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/extensions/string_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/presentation/widgets/images/remote_image_provider.dart';
import 'package:immich_mobile/utils/image_url_builder.dart';

/// Who the user says faces are
sealed class PersonPick {
  const PersonPick();
}

/// A person that exists
class PickedPerson extends PersonPick {
  final Person person;

  const PickedPerson(this.person);
}

/// Someone new, called [name] (which may be empty)
class NewPerson extends PersonPick {
  final String name;

  const NewPerson(this.name);
}

/// Lets the user pick a person, or name a new one; [exclude] is the person the faces are taken from
Future<PersonPick?> showPersonPicker(BuildContext context, {String? exclude}) {
  return showModalBottomSheet<PersonPick>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    backgroundColor: context.colorScheme.surface,
    builder: (_) => PersonPicker(exclude: exclude),
  );
}

class PersonPicker extends ConsumerStatefulWidget {
  final String? exclude;

  const PersonPicker({super.key, this.exclude});

  @override
  ConsumerState<PersonPicker> createState() => _PersonPickerState();
}

class _PersonPickerState extends ConsumerState<PersonPicker> {
  String _search = '';

  @override
  Widget build(BuildContext context) {
    final people = ref.watch(Store.people.all());
    final search = _search.trim();
    final query = search.toLowerCase().removeDiacritics();

    return DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.7,
      maxChildSize: 0.95,
      builder: (context, scrollController) => Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
            child: TextField(
              key: const Key('person-picker-search'),
              autofocus: false,
              decoration: InputDecoration(
                hintText: context.t.search_people,
                prefixIcon: const Icon(Icons.search),
                border: const OutlineInputBorder(),
              ),
              onChanged: (value) => setState(() => _search = value),
            ),
          ),
          ListTile(
            leading: const CircleAvatar(child: Icon(Icons.person_add_alt_1_outlined)),
            title: Text(search.isEmpty ? context.t.create_new_person : '${context.t.create_new_person}: $search'),
            onTap: () => Navigator.of(context).pop(NewPerson(search)),
          ),
          const Divider(height: 1),
          Expanded(
            child: people.when(
              data: (people) {
                final shown = people
                    .where((person) => person.id != widget.exclude)
                    .where((person) => query.isEmpty || person.name.toLowerCase().removeDiacritics().contains(query))
                    .toList(growable: false);
                return ListView.builder(
                  controller: scrollController,
                  itemCount: shown.length,
                  itemBuilder: (context, index) {
                    final person = shown[index];
                    return ListTile(
                      key: ValueKey(person.id),
                      leading: CircleAvatar(
                        backgroundImage: RemoteImageProvider(
                          url: getFaceThumbnailUrl(person.id, updatedAt: person.updatedAt),
                        ),
                      ),
                      title: Text(person.name.isEmpty ? context.t.add_a_name : person.name),
                      onTap: () => Navigator.of(context).pop(PickedPerson(person)),
                    );
                  },
                );
              },
              error: (_, _) => Center(child: Text(context.t.errors.failed_to_load_people)),
              loading: () => const Center(child: CircularProgressIndicator()),
            ),
          ),
        ],
      ),
    );
  }
}
