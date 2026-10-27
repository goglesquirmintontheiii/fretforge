import { configFromEnv } from './config';
import { createServer } from './app';

const cfg = configFromEnv();
createServer(cfg)
  .then((s) => {
    console.log(`Fretforge ${cfg.version} is running at ${s.url}`);
    console.log(`Library folder: ${s.library.watchedDir}`);
    const stop = async () => { await s.close(); process.exit(0); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  })
  .catch((e) => {
    console.error('Fretforge could not start:', e);
    process.exit(1);
  });
