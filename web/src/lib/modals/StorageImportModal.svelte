<script lang="ts">
  import { handleImportDeletedOriginal } from '$lib/services/storage.service';
  import { Field, FormModal, Select, Stack, Text } from '@immich/ui';
  import { mdiImport } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    id: string;
    fileName: string;
    /** Who can get the photo: the owner of the original no longer exists */
    users: { id: string; email: string }[];
    onClose: (imported?: true) => void;
  };

  const { id, fileName, users, onClose }: Props = $props();

  let userId = $state(users[0]?.id ?? '');

  const onSubmit = async () => {
    if (await handleImportDeletedOriginal(id, userId)) {
      onClose(true);
    }
  };
</script>

<FormModal
  title={$t('admin.storage_import_original')}
  icon={mdiImport}
  size="small"
  submitText={$t('admin.storage_import_original')}
  disabled={!userId}
  onClose={() => onClose()}
  {onSubmit}
>
  <Stack gap={4}>
    <Text>{$t('admin.storage_import_original_owner_gone', { values: { fileName } })}</Text>
    <Field label={$t('admin.storage_import_original_user')} required>
      <Select bind:value={userId} options={users.map((user) => ({ label: user.email, value: user.id }))} />
    </Field>
  </Stack>
</FormModal>
