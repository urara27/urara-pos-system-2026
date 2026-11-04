import { buildApp } from './app.js';
import { bootstrap } from './bootstrap.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/client.js';

const config = loadConfig();
const database = openDatabase(config.databasePath, config.migrationsDir);
const { app } = await buildApp({
  db: database.db,
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  webDistDir: config.webDistDir,
  backup: config.backup,
  autoClose: true,
});
await bootstrap(database.db, config, app.log);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'シャットダウンします');
  await app.close();
  database.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.host, port: config.port });
