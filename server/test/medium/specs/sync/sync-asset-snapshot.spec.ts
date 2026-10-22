import { Kysely } from 'kysely';
import { SyncEntityType, SyncRequestType } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { DB } from 'src/schema/index.js';
import { SyncTestContext } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = async (db?: Kysely<DB>) => {
  const ctx = new SyncTestContext(db || defaultDatabase);
  const { auth, user, session } = await ctx.newSyncAuthUser();
  return { auth, user, session, ctx };
};

type Item = { type: string; ack: string; data: unknown };
const ids = (response: Item[], type: string) =>
  response.filter((item) => item.type === type).map((item) => (item.data as { id: string }).id);

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe('first sync of assets', () => {
  it('sends the newest photos first, by the time they were taken and then id', async () => {
    const { auth, ctx } = await setup();
    // uploaded oldest last, some taken at the same time
    const times = ['2021-05-01T10:00:00.000Z', '2024-01-01T00:00:00.000Z', '2022-03-03T12:00:00.000Z'];
    const assets = [];
    for (const time of [...times, times[1], times[1]]) {
      const { asset } = await ctx.newAsset({ ownerId: auth.user.id, fileCreatedAt: time });
      assets.push(asset);
    }

    const response = await ctx.syncStream(auth, [SyncRequestType.AssetsV2]);

    const expected = [...assets]
      .sort((a, b) => String(b.fileCreatedAt).localeCompare(String(a.fileCreatedAt)) || b.id.localeCompare(a.id))
      .map((asset) => asset.id);
    expect(ids(response, SyncEntityType.AssetV2)).toEqual(expected);
    // as many items as upstream sends
    expect(response).toHaveLength(assets.length + 1);

    await ctx.syncAckAll(auth, response);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.AssetsV2]);
  });

  it('goes on where an interrupted first sync stopped, and sends the changes since then after it', async () => {
    const { auth, ctx } = await setup();
    const assetRepo = ctx.get(AssetRepository);
    const assets = [];
    for (let day = 1; day <= 6; day++) {
      const { asset } = await ctx.newAsset({ ownerId: auth.user.id, fileCreatedAt: `2024-01-0${day}T00:00:00.000Z` });
      assets.push(asset);
    }
    const [day1, day2, day3, day4, day5, day6] = assets;

    const first = await ctx.syncStream(auth, [SyncRequestType.AssetsV2]);
    expect(ids(first, SyncEntityType.AssetV2)).toEqual([day6.id, day5.id, day4.id, day3.id, day2.id, day1.id]);
    // the connection broke after the second one
    await ctx.syncAckAll(auth, first.slice(0, 2));

    // meanwhile: a photo not sent yet and one sent already changed, one not sent yet was deleted, and one is new
    await assetRepo.update({ id: day3.id, isFavorite: true });
    await assetRepo.update({ id: day6.id, isFavorite: true });
    await assetRepo.remove(day2);
    const { asset: added } = await ctx.newAsset({ ownerId: auth.user.id, fileCreatedAt: '2024-01-09T00:00:00.000Z' });

    const second = await ctx.syncStream(auth, [SyncRequestType.AssetsV2]);
    // the rest of the first sync as it was, then the changes in their order
    expect(ids(second, SyncEntityType.AssetV2)).toEqual([day4.id, day1.id, day3.id, day6.id, added.id]);
    expect(second).toContainEqual(expect.objectContaining({ type: SyncEntityType.AssetDeleteV1 }));

    await ctx.syncAckAll(auth, second);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.AssetsV2]);
  });

  it('does not skip a photo taken in the same millisecond', async () => {
    const { auth, ctx } = await setup();
    const { asset: later } = await ctx.newAsset({
      ownerId: auth.user.id,
      fileCreatedAt: '2024-01-01T00:00:00.000900Z',
    });
    const { asset: earlier } = await ctx.newAsset({
      ownerId: auth.user.id,
      fileCreatedAt: '2024-01-01T00:00:00.000100Z',
    });

    const first = await ctx.syncStream(auth, [SyncRequestType.AssetsV2]);
    expect(ids(first, SyncEntityType.AssetV2)).toEqual([later.id, earlier.id]);
    await ctx.syncAckAll(auth, first.slice(0, 1));

    const second = await ctx.syncStream(auth, [SyncRequestType.AssetsV2]);
    expect(ids(second, SyncEntityType.AssetV2)).toEqual([earlier.id]);
  });

  it('completes a first sync in progress of which nothing is left', async () => {
    const { auth, ctx } = await setup();
    const { asset: older } = await ctx.newAsset({ ownerId: auth.user.id, fileCreatedAt: '2024-01-01T00:00:00.000Z' });
    const { asset: newer } = await ctx.newAsset({ ownerId: auth.user.id, fileCreatedAt: '2024-01-02T00:00:00.000Z' });
    const first = await ctx.syncStream(auth, [SyncRequestType.AssetsV2]);
    await ctx.syncAckAll(auth, first.slice(0, 1));
    await ctx.get(AssetRepository).update({ id: older.id, isFavorite: true });

    const second = await ctx.syncStream(auth, [SyncRequestType.AssetsV2]);

    // the change completes it
    expect(second).toEqual([
      expect.objectContaining({ type: SyncEntityType.AssetV2, data: expect.objectContaining({ id: older.id }) }),
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);
    expect(ids(first, SyncEntityType.AssetV2)).toEqual([newer.id, older.id]);
    await ctx.syncAckAll(auth, second);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.AssetsV2]);
  });

  it('completes a first sync in progress of which nothing is left, also without changes', async () => {
    const { auth, ctx } = await setup();
    const { asset: older } = await ctx.newAsset({ ownerId: auth.user.id, fileCreatedAt: '2024-01-01T00:00:00.000Z' });
    await ctx.newAsset({ ownerId: auth.user.id, fileCreatedAt: '2024-01-02T00:00:00.000Z' });
    const first = await ctx.syncStream(auth, [SyncRequestType.AssetsV2]);
    await ctx.syncAckAll(auth, first.slice(0, 1));
    await ctx.get(AssetRepository).remove(older);

    const second = await ctx.syncStream(auth, [SyncRequestType.AssetsV2]);

    expect(second).toEqual([
      expect.objectContaining({ type: SyncEntityType.AssetDeleteV1 }),
      expect.objectContaining({ type: SyncEntityType.SyncAckV1, ack: expect.stringMatching(/^AssetV2\|[^|]+$/) }),
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);
    await ctx.syncAckAll(auth, second);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.AssetsV2]);
  });

  it('sends the photos of partners newest first, and backfills a partner added while it is in progress', async () => {
    const { auth, ctx } = await setup();
    const { user: partner } = await ctx.newUser();
    const { user: laterPartner } = await ctx.newUser();
    await ctx.newPartner({ sharedById: partner.id, sharedWithId: auth.user.id });
    const { asset: old } = await ctx.newAsset({ ownerId: partner.id, fileCreatedAt: '2020-01-01T00:00:00.000Z' });
    const { asset: recent } = await ctx.newAsset({ ownerId: partner.id, fileCreatedAt: '2024-01-01T00:00:00.000Z' });
    const { asset: middle } = await ctx.newAsset({ ownerId: partner.id, fileCreatedAt: '2022-01-01T00:00:00.000Z' });
    const { asset: ofLaterPartner } = await ctx.newAsset({
      ownerId: laterPartner.id,
      fileCreatedAt: '2023-01-01T00:00:00.000Z',
    });

    const first = await ctx.syncStream(auth, [SyncRequestType.PartnerAssetsV2]);
    expect(ids(first, SyncEntityType.PartnerAssetV2)).toEqual([recent.id, middle.id, old.id]);
    await ctx.syncAckAll(auth, first.slice(0, 1));

    await ctx.newPartner({ sharedById: laterPartner.id, sharedWithId: auth.user.id });
    const second = await ctx.syncStream(auth, [SyncRequestType.PartnerAssetsV2]);
    // the rest (with the later partner's photo, as the snapshot reads the partners of now), then the backfill
    expect(ids(second, SyncEntityType.PartnerAssetV2)).toEqual([ofLaterPartner.id, middle.id, old.id]);
    await ctx.syncAckAll(auth, second);

    const third = await ctx.syncStream(auth, [SyncRequestType.PartnerAssetsV2]);
    expect(ids(third, SyncEntityType.PartnerAssetBackfillV2)).toEqual([ofLaterPartner.id]);
    await ctx.syncAckAll(auth, third);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.PartnerAssetsV2]);
  });
});
