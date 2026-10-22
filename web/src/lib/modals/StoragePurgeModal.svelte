<script lang="ts">
  import { handlePurgeDeletedOriginal } from '$lib/services/storage.service';
  import { Field, FormModal, HelperText, PasswordInput, Stack, Text } from '@immich/ui';
  import { mdiDeleteForeverOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    id: string;
    fileName: string;
    onClose: (purged?: true) => void;
  };

  const { id, fileName, onClose }: Props = $props();

  let password = $state('');

  const onSubmit = async () => {
    if (await handlePurgeDeletedOriginal(id, password)) {
      onClose(true);
    }
  };
</script>

<FormModal
  title={$t('admin.storage_purge_original')}
  icon={mdiDeleteForeverOutline}
  size="small"
  submitColor="danger"
  submitText={$t('admin.storage_purge_original')}
  disabled={!password}
  onClose={() => onClose()}
  {onSubmit}
>
  <Stack gap={4}>
    <Text>{$t('admin.storage_purge_original_description', { values: { fileName } })}</Text>
    <Field label={$t('confirm_password')} required>
      <PasswordInput bind:value={password} autocomplete="current-password" />
      <HelperText color="muted">{$t('admin.storage_purge_original_password')}</HelperText>
    </Field>
  </Stack>
</FormModal>
