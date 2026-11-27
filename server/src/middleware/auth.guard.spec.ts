import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard, Authenticated } from 'src/middleware/auth.guard.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { AuthService } from 'src/services/auth.service.js';
import { markAppPortRequest } from 'src/utils/app-port.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

class TestController {
  @Authenticated({ public: true, setup: true })
  setupRoute() {}

  @Authenticated({ public: true })
  publicRoute() {}

  @Authenticated({ public: true, app: true })
  appRoute() {}

  @Authenticated()
  userRoute() {}

  @Authenticated({ sharedLink: true })
  sharedLinkRoute() {}

  undecoratedRoute() {}
}

@Authenticated({ admin: true })
class AdminTestController {
  route() {}
}

const contextFor = (handler: () => void, controller: object = TestController, { appPort = false } = {}) => {
  const request = { headers: {}, query: {}, path: '/' };
  if (appPort) {
    markAppPortRequest(request as never);
  }
  return {
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
};

const onAppPort = (handler: () => void, controller: object = TestController) =>
  contextFor(handler, controller, { appPort: true });

describe(AuthGuard.name, () => {
  let sut: AuthGuard;
  let authService: AuthService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut: authService, mocks } = newTestService(AuthService));
    sut = new AuthGuard(mocks.logger as unknown as LoggingRepository, new Reflector(), authService);
  });

  describe('setup routes', () => {
    it('should allow access while the server is awaiting its first admin', async () => {
      mocks.user.hasAdmin.mockResolvedValue(false);
      const authenticate = vitest.spyOn(authService, 'authenticate');

      await expect(sut.canActivate(contextFor(TestController.prototype.setupRoute))).resolves.toBe(true);

      expect(authenticate).not.toHaveBeenCalled();
    });

    it('should reject when setup is disabled', async () => {
      mocks.config.getEnv.mockReturnValue(mockEnvData({ setup: { allow: false } }));
      mocks.user.hasAdmin.mockResolvedValue(false);

      await expect(sut.canActivate(contextFor(TestController.prototype.setupRoute))).rejects.toThrowError(
        'Admin setup is not available',
      );
    });

    it('should reject when the server already has an admin', async () => {
      mocks.user.hasAdmin.mockResolvedValue(true);

      await expect(sut.canActivate(contextFor(TestController.prototype.setupRoute))).rejects.toThrowError(
        'Admin setup is not available',
      );
    });
  });

  describe('public routes', () => {
    it('should not require setup availability', async () => {
      mocks.user.hasAdmin.mockResolvedValue(true);

      await expect(sut.canActivate(contextFor(TestController.prototype.publicRoute))).resolves.toBe(true);
    });
  });

  describe('undecorated routes', () => {
    it('should be rejected', async () => {
      const authenticate = vitest.spyOn(authService, 'authenticate');

      await expect(sut.canActivate(contextFor(TestController.prototype.undecoratedRoute))).rejects.toThrowError(
        'does not declare @Authenticated()',
      );

      expect(authenticate).not.toHaveBeenCalled();
    });
  });

  describe('class-level @Authenticated()', () => {
    it('should apply the controller options to its undecorated routes', async () => {
      const authenticate = vitest.spyOn(authService, 'authenticate').mockResolvedValue({} as never);

      await expect(sut.canActivate(contextFor(AdminTestController.prototype.route, AdminTestController))).resolves.toBe(
        true,
      );

      expect(authenticate).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: expect.objectContaining({ adminRoute: true }) }),
      );
    });
  });

  describe('the port of the mobile app in self-signed mode', () => {
    it('should close the administration, even to administrators', async () => {
      const authenticate = vitest.spyOn(authService, 'authenticate');

      await expect(
        sut.canActivate(onAppPort(AdminTestController.prototype.route, AdminTestController)),
      ).rejects.toThrow('Not available on this port');
      expect(authenticate).not.toHaveBeenCalled();
    });

    it('should close the public routes but those the app needs to be signed in by a QR code', async () => {
      await expect(sut.canActivate(onAppPort(TestController.prototype.publicRoute))).rejects.toThrow(
        'Not available on this port',
      );
      await expect(sut.canActivate(onAppPort(TestController.prototype.setupRoute))).rejects.toThrow(
        'Not available on this port',
      );
      await expect(sut.canActivate(onAppPort(TestController.prototype.appRoute))).resolves.toBe(true);
    });

    it('should take sessions, but no shared links', async () => {
      const authenticate = vitest.spyOn(authService, 'authenticate').mockResolvedValue({} as never);

      await expect(sut.canActivate(onAppPort(TestController.prototype.userRoute))).resolves.toBe(true);
      await expect(sut.canActivate(onAppPort(TestController.prototype.sharedLinkRoute))).resolves.toBe(true);
      expect(authenticate).toHaveBeenLastCalledWith(
        expect.objectContaining({ metadata: expect.objectContaining({ sharedLinkRoute: false, adminRoute: false }) }),
      );

      await expect(sut.canActivate(contextFor(TestController.prototype.sharedLinkRoute))).resolves.toBe(true);
      expect(authenticate).toHaveBeenLastCalledWith(
        expect.objectContaining({ metadata: expect.objectContaining({ sharedLinkRoute: true }) }),
      );
    });

    it('should leave the other port as it was', async () => {
      await expect(sut.canActivate(contextFor(TestController.prototype.publicRoute))).resolves.toBe(true);
    });
  });
});
