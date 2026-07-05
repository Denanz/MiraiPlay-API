import { buildApp } from './app.js';
import { settings } from './config/settings.js';
import { startEpisodeWatcher } from './services/notify-episodes.js';

async function start(): Promise<void> {
  const app = await buildApp();

  const stop = async (signal: string) => {
    app.log.info(`received ${signal}, shutting down`);
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      app.log.error(err);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));

  try {
    await app.listen({ host: settings.HOST, port: settings.PORT });
    startEpisodeWatcher();
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void start();
