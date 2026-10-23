import request from 'supertest';
import { StorageAdminController } from 'src/controllers/storage-admin.controller.js';
import { StorageService } from 'src/services/storage.service.js';
import { ControllerContext, controllerSetup, mockBaseService } from 'test/utils.js';

describe(StorageAdminController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(StorageService);

  beforeAll(async () => {
    ctx = await controllerSetup(StorageAdminController, [{ provide: StorageService, useValue: service }]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
  });

  describe('POST /admin/storage/master-keys/export', () => {
    it('should require the password of the administrator', async () => {
      const { status } = await request(ctx.getHttpServer()).post('/admin/storage/master-keys/export').send({});
      expect(status).toBe(400);
      expect(service.exportMasterKeys).not.toHaveBeenCalled();
    });

    it('should not let the key file be cached', async () => {
      service.exportMasterKeys.mockResolvedValue({ keyId: 'id', fileName: 'keys.txt', keyFile: 'key' });

      const { status, headers } = await request(ctx.getHttpServer())
        .post('/admin/storage/master-keys/export')
        .send({ password: 'secret' });

      expect(status).toBe(200);
      expect(headers['cache-control']).toBe('no-store');
      expect(service.exportMasterKeys).toHaveBeenCalledWith(undefined, { password: 'secret' });
    });
  });
});
