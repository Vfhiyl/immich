import request from 'supertest';
import { StorageDeletionAdminController } from 'src/controllers/storage-deletion-admin.controller.js';
import { AssetMediaService } from 'src/services/asset-media.service.js';
import { StorageDeletionService } from 'src/services/storage-deletion.service.js';
import { factory } from 'test/small.factory.js';
import { ControllerContext, controllerSetup, mockBaseService } from 'test/utils.js';

describe(StorageDeletionAdminController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(StorageDeletionService);
  const assetMediaService = mockBaseService(AssetMediaService);

  beforeAll(async () => {
    ctx = await controllerSetup(StorageDeletionAdminController, [
      { provide: StorageDeletionService, useValue: service },
      { provide: AssetMediaService, useValue: assetMediaService },
    ]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    assetMediaService.resetAllMocks();
    ctx.reset();
  });

  describe('GET /admin/storage/deletions/originals', () => {
    it('should limit the size of a page', async () => {
      const { status } = await request(ctx.getHttpServer()).get('/admin/storage/deletions/originals?limit=5000');
      expect(status).toBe(400);
    });

    it('should filter by owner', async () => {
      const ownerId = factory.uuid();
      await request(ctx.getHttpServer()).get(`/admin/storage/deletions/originals?ownerId=${ownerId}&limit=10`);
      expect(service.listOriginals).toHaveBeenCalledWith({ ownerId, limit: 10 });
    });
  });

  describe('POST /admin/storage/deletions/originals/:id/import', () => {
    it('should require a valid uuid', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .post('/admin/storage/deletions/originals/123/import')
        .send({});
      expect(status).toBe(400);
      expect(body).toEqual(factory.responses.validationError([{ path: ['id'], message: 'Invalid UUID' }]));
    });

    it('should import for the owner unless another user is chosen', async () => {
      const id = factory.uuid();
      await request(ctx.getHttpServer()).post(`/admin/storage/deletions/originals/${id}/import`).send({});
      expect(assetMediaService.importDeletedOriginal).toHaveBeenCalledWith(undefined, id, {});

      const { status } = await request(ctx.getHttpServer())
        .post(`/admin/storage/deletions/originals/${id}/import`)
        .send({ userId: 'someone' });
      expect(status).toBe(400);
    });
  });

  describe('POST /admin/storage/deletions/originals/:id/purge', () => {
    it('should require the password of the administrator', async () => {
      const id = factory.uuid();
      const { status } = await request(ctx.getHttpServer())
        .post(`/admin/storage/deletions/originals/${id}/purge`)
        .send({});
      expect(status).toBe(400);
      expect(service.purgeOriginal).not.toHaveBeenCalled();

      await request(ctx.getHttpServer())
        .post(`/admin/storage/deletions/originals/${id}/purge`)
        .send({ password: 'secret' });
      expect(service.purgeOriginal).toHaveBeenCalledWith(undefined, id, { password: 'secret' });
    });
  });

  describe('POST /admin/storage/deletions/resume', () => {
    it('should resume deleting', async () => {
      const { status } = await request(ctx.getHttpServer()).post('/admin/storage/deletions/resume');
      expect(status).toBe(204);
      expect(service.resume).toHaveBeenCalled();
    });
  });
});
