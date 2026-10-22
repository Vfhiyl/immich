<script lang="ts">
  import SettingInputField from '$lib/components/shared-components/settings/SettingInputField.svelte';
  import SettingSwitch from '$lib/components/shared-components/settings/SettingSwitch.svelte';
  import SettingButtonsRow from '$lib/components/shared-components/settings/SystemConfigButtonRow.svelte';
  import { SettingInputFieldType } from '$lib/constants';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { systemConfigManager } from '$lib/managers/system-config-manager.svelte';
  import { pricedBackendIds, togglePricing } from '$lib/utils/storage-pricing';
  import { getStorageConfiguration } from '@immich/sdk';
  import { Text } from '@immich/ui';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { fade } from 'svelte/transition';

  const disabled = $derived(featureFlagsManager.value.configFile);
  let configToEdit = $state(systemConfigManager.cloneValue());
  let configured = $state<string[]>([]);

  onMount(async () => {
    const { backends } = await getStorageConfiguration();
    configured = backends.map(({ id }) => id);
  });

  const backendIds = $derived(pricedBackendIds(configured, configToEdit.storagePricing.backends));

  const prices = [
    { key: 'storageGbMonth', label: 'admin.storage_pricing_storage' },
    { key: 'writeRequests10k', label: 'admin.storage_pricing_write' },
    { key: 'readRequests10k', label: 'admin.storage_pricing_read' },
    { key: 'deleteRequests10k', label: 'admin.storage_pricing_delete' },
    { key: 'egressGb', label: 'admin.storage_pricing_egress' },
  ] as const;
</script>

<div>
  <div in:fade={{ duration: 500 }}>
    <form autocomplete="off" onsubmit={(event) => event.preventDefault()}>
      <div class="ms-4 mt-4 flex flex-col gap-4">
        <Text size="small" color="muted">{$t('admin.storage_pricing_description')}</Text>
        {#if backendIds.length === 0}
          <Text size="small">{$t('admin.storage_no_backends')}</Text>
        {/if}
        {#each backendIds as backendId (backendId)}
          {@const index = configToEdit.storagePricing.backends.findIndex((pricing) => pricing.backendId === backendId)}
          <SettingSwitch
            title={$t('admin.storage_pricing_backend', { values: { backendId } })}
            {disabled}
            checked={index !== -1}
            onToggle={(enabled) =>
              (configToEdit.storagePricing.backends = togglePricing(
                configToEdit.storagePricing.backends,
                backendId,
                enabled,
              ))}
          />
          {#if index !== -1}
            <div class="ms-4 flex flex-col gap-4">
              <SettingInputField
                inputType={SettingInputFieldType.TEXT}
                label={$t('admin.storage_pricing_currency')}
                bind:value={configToEdit.storagePricing.backends[index].currency}
                required={true}
                {disabled}
              />
              {#each prices as { key, label } (key)}
                <SettingInputField
                  inputType={SettingInputFieldType.NUMBER}
                  label={$t(label)}
                  bind:value={configToEdit.storagePricing.backends[index][key]}
                  min={0}
                  step="any"
                  required={true}
                  {disabled}
                />
              {/each}
              <SettingInputField
                inputType={SettingInputFieldType.NUMBER}
                label={$t('admin.storage_pricing_budget')}
                description={$t('admin.storage_pricing_budget_description')}
                bind:value={configToEdit.storagePricing.backends[index].monthlyBudget}
                min={0}
                step="any"
                {disabled}
              />
            </div>
          {/if}
        {/each}

        <SettingButtonsRow bind:configToEdit keys={['storagePricing']} {disabled} />
      </div>
    </form>
  </div>
</div>
