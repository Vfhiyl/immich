<script lang="ts">
  import AdminPageLayout from '$lib/components/layouts/AdminPageLayout.svelte';
  import StoragePurgeModal from '$lib/modals/StoragePurgeModal.svelte';
  import { Route } from '$lib/route';
  import { formatAge, handleImportDeletedOriginal } from '$lib/services/storage.service';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import { getBaseUrl, getDeletedOriginals } from '@immich/sdk';
  import {
    Button,
    Container,
    HStack,
    modalManager,
    Table,
    TableBody,
    TableCell,
    TableHeader,
    TableHeading,
    TableRow,
    Text,
  } from '@immich/ui';
  import { DateTime } from 'luxon';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  type Props = {
    data: PageData;
  };

  const { data }: Props = $props();

  let originals = $state(data.originals);
  const owners = $derived(new Map(data.users.map((user) => [user.id, user.email])));

  const fileUrl = (id: string) => `${getBaseUrl()}/admin/storage/deletions/originals/${id}/file`;

  const loadMore = async () => {
    const { items, nextCursor } = await getDeletedOriginals({ cursor: originals.nextCursor });
    originals.items.push(...items);
    originals.nextCursor = nextCursor;
  };

  const remove = (id: string) => {
    originals.items = originals.items.filter((original) => original.id !== id);
  };

  const onImport = async (id: string) => {
    if (await handleImportDeletedOriginal(id)) {
      remove(id);
    }
  };

  const onPurge = async (id: string, fileName: string) => {
    const purged = await modalManager.show(StoragePurgeModal, { id, fileName });
    if (purged) {
      remove(id);
    }
  };
</script>

<AdminPageLayout breadcrumbs={[{ title: $t('admin.storage'), href: Route.storage() }, { title: data.meta.title }]}>
  <Container size="large" center class="my-4 flex flex-col gap-4 pb-28">
    <Text size="small" color="muted">{$t('admin.storage_deleted_originals_description')}</Text>
    <Table striped spacing="tiny">
      <TableHeader>
        <TableHeading>{$t('filename')}</TableHeading>
        <TableHeading>{$t('owner')}</TableHeading>
        <TableHeading>{$t('admin.storage_deleted_at')}</TableHeading>
        <TableHeading>{$t('admin.storage_delete_after')}</TableHeading>
        <TableHeading />
      </TableHeader>
      <TableBody>
        {#each originals.items as original (original.id)}
          {@const fileName = original.originalFileName ?? original.id}
          <TableRow>
            <TableCell class="break-all">
              <a href={fileUrl(original.id)} target="_blank" rel="noreferrer" class="underline">{fileName}</a>
              <Text size="tiny" color="muted">
                {original.size === null ? '' : getByteUnitString(original.size)}
                {original.fileCreatedAt
                  ? DateTime.fromISO(original.fileCreatedAt).toLocaleString(DateTime.DATE_MED)
                  : ''}
              </Text>
            </TableCell>
            <TableCell>{(original.ownerId && owners.get(original.ownerId)) ?? '–'}</TableCell>
            <TableCell>{formatAge(original.deletedAt)}</TableCell>
            <TableCell>{DateTime.fromISO(original.deleteAfter).toLocaleString(DateTime.DATE_MED)}</TableCell>
            <TableCell>
              <HStack gap={1}>
                <Button size="tiny" variant="ghost" onclick={() => onImport(original.id)}>
                  {$t('admin.storage_import_original')}
                </Button>
                <Button size="tiny" variant="ghost" color="danger" onclick={() => onPurge(original.id, fileName)}>
                  {$t('admin.storage_purge_original')}
                </Button>
              </HStack>
            </TableCell>
          </TableRow>
        {:else}
          <TableRow><TableCell>{$t('admin.storage_no_deleted_originals')}</TableCell></TableRow>
        {/each}
      </TableBody>
    </Table>
    {#if originals.nextCursor}
      <div class="flex justify-center">
        <Button size="medium" color="secondary" onclick={() => loadMore()}>{$t('load_more')}</Button>
      </div>
    {/if}
  </Container>
</AdminPageLayout>
