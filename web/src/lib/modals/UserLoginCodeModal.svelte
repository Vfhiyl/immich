<script lang="ts">
  import Qrcode from '#lib/components/shared-components/Qrcode.svelte';
  import { OpenQueryParam } from '#lib/constants.ts';
  import { Route } from '#lib/route.ts';
  import { getServerErrorMessage, handleError } from '#lib/utils/handle-error.ts';
  import { createUserLoginCodeAdmin, type LoginCodeResponseDto, type UserAdminResponseDto } from '@immich/sdk';
  import { Alert, Button, Modal, ModalBody, Stack, Text } from '@immich/ui';
  import { mdiQrcode, mdiRefresh } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { onDestroy, onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    user: UserAdminResponseDto;
    onClose: () => void;
  };

  const { user, onClose }: Props = $props();

  let loginCode = $state<LoginCodeResponseDto>();
  let needsDomain = $state(false);
  let now = $state(Date.now());
  let modalWidth = $state(0);

  const isExpired = $derived(!!loginCode && now >= new Date(loginCode.expiresAt).getTime());
  // in self-signed mode, the key of the server's HTTPS port as the app shows it: 16 groups of 4 hexadecimal digits
  const key = $derived(
    loginCode?.pin
      ? Array.from(atob(loginCode.pin), (character) => character.codePointAt(0)!.toString(16).padStart(2, '0'))
          .join('')
          .toUpperCase()
          .match(/.{4}/g)
      : undefined,
  );

  const create = async () => {
    try {
      loginCode = await createUserLoginCodeAdmin({ id: user.id });
      now = Date.now();
    } catch (error) {
      // the phone signs in to the external domain, which the settings must have
      if (getServerErrorMessage(error)?.includes('external domain')) {
        needsDomain = true;
        return;
      }
      handleError(error, $t('errors.unable_to_create_login_code'));
    }
  };

  const timer = setInterval(() => (now = Date.now()), 1000);
  onDestroy(() => clearInterval(timer));
  onMount(() => create());
</script>

<Modal
  title={$t('admin.user_login_code_title', { values: { user: user.name } })}
  icon={mdiQrcode}
  {onClose}
  size="small"
>
  <ModalBody>
    <Stack gap={4}>
      {#if needsDomain}
        <Alert color="warning" title={$t('admin.user_login_code_needs_domain')} />
        <div>
          <Button size="small" href={Route.systemSettings({ isOpen: OpenQueryParam.SERVER })}>
            {$t('admin.user_login_code_open_settings')}
          </Button>
        </div>
      {:else if loginCode}
        <Text size="small">{$t('admin.user_login_code_description')}</Text>
        <div bind:clientWidth={modalWidth} class="w-full" data-testid="login-code" data-value={loginCode.url}>
          {#if isExpired}
            <Alert color="info" title={$t('admin.user_login_code_expired')} />
          {:else}
            <Qrcode value={loginCode.url} width={modalWidth} />
          {/if}
        </div>
        <Text size="small" color="muted">
          {isExpired
            ? $t('admin.user_login_code_server', { values: { server: loginCode.server } })
            : $t('admin.user_login_code_valid', {
                values: {
                  server: loginCode.server,
                  time: DateTime.fromISO(loginCode.expiresAt).toLocaleString(DateTime.TIME_SIMPLE),
                },
              })}
        </Text>
        {#if key}
          <Text size="small">{$t('admin.user_login_code_key')}</Text>
          <code class="grid grid-cols-4 gap-x-3 text-sm" data-testid="login-code-key">
            {#each key as group, index (index)}
              <span>{group}</span>
            {/each}
          </code>
        {/if}
        {#if isExpired}
          <div>
            <Button size="small" leadingIcon={mdiRefresh} onclick={create}>{$t('admin.user_login_code_new')}</Button>
          </div>
        {/if}
      {/if}
    </Stack>
  </ModalBody>
</Modal>
