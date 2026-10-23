<script lang="ts">
  import { handleDownloadMasterKeys } from '$lib/services/storage.service';
  import { Field, FormModal, HelperText, PasswordInput, Stack, Text } from '@immich/ui';
  import { mdiKeyOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    onClose: (downloaded?: true) => void;
  };

  const { onClose }: Props = $props();

  let password = $state('');

  const onSubmit = async () => {
    if (await handleDownloadMasterKeys(password)) {
      onClose(true);
    }
  };
</script>

<FormModal
  title={$t('admin.storage_master_key_download')}
  icon={mdiKeyOutline}
  size="small"
  submitText={$t('admin.storage_master_key_download')}
  disabled={!password}
  onClose={() => onClose()}
  {onSubmit}
>
  <Stack gap={4}>
    <Text>{$t('admin.storage_master_key_download_description')}</Text>
    <Field label={$t('confirm_password')} required>
      <PasswordInput bind:value={password} autocomplete="current-password" />
      <HelperText color="muted">{$t('admin.storage_master_key_download_password')}</HelperText>
    </Field>
  </Stack>
</FormModal>
