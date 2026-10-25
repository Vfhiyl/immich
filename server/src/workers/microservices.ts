import { NestFactory } from '@nestjs/core';
import { MicroservicesModule } from 'src/app.module.js';
import { serverVersion } from 'src/constants.js';
import { WebSocketAdapter } from 'src/middleware/websocket.adapter.js';
import { AppRepository } from 'src/repositories/app.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { bootstrapTelemetry } from 'src/repositories/telemetry.repository.js';
import { isStartUpError } from 'src/utils/misc.js';
import { preferAsOomVictim } from 'src/utils/worker-restart.js';

async function bootstrap() {
  process.title = 'immich-microservices';
  preferAsOomVictim();

  const { telemetry } = new ConfigRepository().getEnv();
  if (telemetry.metrics.size > 0) {
    bootstrapTelemetry(telemetry.microservicesPort);
  }

  const app = await NestFactory.create(MicroservicesModule, { bufferLogs: true });
  const logger = await app.resolve(LoggingRepository);
  const configRepository = app.get(ConfigRepository);
  app.get(AppRepository).setCloseFn(() => app.close());

  const { environment, host } = configRepository.getEnv();

  logger.setContext('Bootstrap');
  app.useLogger(logger);
  app.useWebSocketAdapter(new WebSocketAdapter(app));

  await (host ? app.listen(0, host) : app.listen(0));

  logger.log(`Immich Microservices is running [v${serverVersion}] [${environment}] `);
}

bootstrap().catch((error) => {
  if (!isStartUpError(error)) {
    console.error(error);
  }
  // eslint-disable-next-line unicorn/no-process-exit
  process.exit(1);
});
