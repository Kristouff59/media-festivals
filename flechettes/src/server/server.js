// Point d'entrée : `npm start` (PORT et DATA_DIR configurables).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '0.0.0.0';
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, 'data');
const { server } = createApp({ dataDir, log: process.env.LOG !== '0' });
server.listen(port, host, () => {
  console.log(`Tournois de fléchettes — http://localhost:${port}  (données : ${dataDir})`);
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); process.exit(0); });
