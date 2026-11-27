import { NestExpressApplication } from '@nestjs/platform-express';
import { json, urlencoded } from 'body-parser';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { Request, Response } from 'express';
import helmetMiddleware from 'helmet';
import { existsSync } from 'node:fs';
import { Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import sirv from 'sirv';
import { IMMICH_SERVER_START, excludePaths, serverVersion } from 'src/constants.js';
import { MaintenanceWorkerService } from 'src/maintenance/maintenance-worker.service.js';
import { WebSocketAdapter } from 'src/middleware/websocket.adapter.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { bootstrapTelemetry } from 'src/repositories/telemetry.repository.js';
import { ApiService } from 'src/services/api.service.js';
import { isAppPortRequest, markAppPortRequest } from 'src/utils/app-port.js';
import { useSwagger } from 'src/utils/misc.js';
import { detectMediaLocation } from 'src/utils/storage.js';
import { formatPin, getTlsLocation, loadSelfSignedCertificate } from 'src/utils/tls.js';

const TLS_RENEW_CHECK_MS = 24 * 60 * 60 * 1000;

export function configureTelemetry() {
  const { telemetry } = new ConfigRepository().getEnv();
  if (telemetry.metrics.size > 0) {
    bootstrapTelemetry(telemetry.apiPort);
  }
}

export async function configureExpress(
  app: NestExpressApplication,
  {
    permitSwaggerWrite = true,
    ssr,
    appPortPaths,
  }: {
    /**
    Whether to allow swagger module to write to the specs.json
    This is not desirable when the API is not available
    @default true
    */
    permitSwaggerWrite?: boolean;
    /** Service to use for server-side rendering */
    ssr: typeof ApiService | typeof MaintenanceWorkerService;
    /**
    In self-signed mode, the paths open on the port of the mobile app; by default the API (where the routes decide,
    see AuthGuard) and `/.well-known/immich`
    */
    appPortPaths?: (path: string) => boolean;
  },
) {
  const configRepository = app.get(ConfigRepository);
  const { environment, host, port, helmet, resourcePaths, network, selfSignedTls, storage } = configRepository.getEnv();

  const logger = await app.resolve(LoggingRepository);
  logger.setContext('Bootstrap');
  app.useLogger(logger);

  app.set('trust proxy', ['loopback', ...network.trustedProxies]);
  app.set('etag', 'strong');

  if (selfSignedTls) {
    // the port of the mobile app has no web
    const isAppPortPath =
      appPortPaths ?? ((path: string) => path.startsWith('/api/') || path === '/.well-known/immich');
    app.use((request: Request, response: Response, next: () => void) => {
      if (isAppPortRequest(request) && !isAppPortPath(request.path)) {
        response.status(404).end();
        return;
      }
      next();
    });
  }

  if (helmet.config) {
    app.use(helmetMiddleware(helmet.config));
    logger.log('Initialized helmet middleware');
  }

  app.use(cookieParser());
  app.use(json({ limit: '10mb' }));
  app.use(urlencoded({ limit: '10mb' }));

  if (configRepository.isDev()) {
    app.enableCors();
  }

  app.setGlobalPrefix('api', { exclude: excludePaths });
  app.useWebSocketAdapter(new WebSocketAdapter(app));

  useSwagger(app, { write: configRepository.isDev() && permitSwaggerWrite });

  if (existsSync(resourcePaths.web.root)) {
    // copied from https://github.com/sveltejs/kit/blob/679b5989fe62e3964b9a73b712d7b41831aa1f07/packages/adapter-node/src/handler.js#L46
    // provides serving of precompressed assets and caching of immutable assets
    app.use(
      sirv(resourcePaths.web.root, {
        etag: true,
        gzip: true,
        brotli: true,
        extensions: [],
        setHeaders: (res, pathname) => {
          if (pathname.startsWith(`/_app/immutable`) && res.statusCode === 200) {
            res.setHeader('cache-control', 'public,max-age=31536000,immutable');
          }
        },
      }),
    );
  }

  app.use(app.get(ssr).ssr(excludePaths));
  app.use(compression());

  const prepare = (server: Server) => {
    server.requestTimeout = 24 * 60 * 60 * 1000;
    // make sure every socket always has an error handler
    server.on('connection', (socket) => {
      socket.on('error', (error) => {
        logger.debug(`Socket error: ${error.message}`);
      });
    });
  };

  if (!selfSignedTls) {
    const server = await (host ? app.listen(port, host) : app.listen(port));
    prepare(server);
    logger.log(`${IMMICH_SERVER_START} on ${await app.getUrl()} [v${serverVersion}] [${environment}] `);
    return;
  }

  // self-signed mode: the web and the administration on a port for this machine, the mobile app on HTTPS
  const location = getTlsLocation(selfSignedTls, detectMediaLocation(storage.mediaLocation, existsSync));
  const { certificate, created } = await loadSelfSignedCertificate(location);
  if (created === 'key') {
    logger.warn(`Created the key of the HTTPS port in ${location}: phones signed in before must scan a QR code again`);
  }
  logger.log(`Public key of the HTTPS port (SHA-256): ${formatPin(certificate.pin)}`);

  const adminServer: Server = await app.listen(selfSignedTls.adminPort, selfSignedTls.adminHost);
  prepare(adminServer);

  // the same handlers as the administration port's (Express, Socket.IO), for requests marked as the app's
  const appServer = createHttpsServer(
    { key: certificate.key, cert: certificate.certificate, minVersion: 'TLSv1.2' },
    (request, response) => {
      markAppPortRequest(request);
      adminServer.emit('request', request, response);
    },
  );
  appServer.on('upgrade', (request, socket, head) => {
    markAppPortRequest(request);
    adminServer.emit('upgrade', request, socket, head);
  });
  prepare(appServer);
  await new Promise<void>((resolve, reject) => {
    appServer.once('error', reject);
    appServer.listen(port, host, resolve);
  });

  const renew = setInterval(() => {
    loadSelfSignedCertificate(location)
      .then(({ certificate, created }) => {
        if (!created) {
          return;
        }
        appServer.setSecureContext({ key: certificate.key, cert: certificate.certificate, minVersion: 'TLSv1.2' });
        logger.log(
          `Renewed the certificate of the HTTPS port (same key), valid until ${certificate.notAfter.toISOString()}`,
        );
      })
      .catch((error: Error) => logger.error(`Failed to renew the certificate of the HTTPS port: ${error.message}`));
  }, TLS_RENEW_CHECK_MS);
  renew.unref();

  logger.log(
    `${IMMICH_SERVER_START} on https://${host ?? '*'}:${port} for the mobile app, and on ` +
      `http://${selfSignedTls.adminHost}:${selfSignedTls.adminPort} for the web and the administration ` +
      `[v${serverVersion}] [${environment}] `,
  );
}
