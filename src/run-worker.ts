import { parentPort, workerData } from 'node:worker_threads';
import { runPipeline } from './pipeline.js';

const { sourcesUrl, token, outputDir, dbFile } = workerData as {
  sourcesUrl: string;
  token: string;
  outputDir: string;
  dbFile: string;
};

try {
  const records = await runPipeline(sourcesUrl, token, outputDir, dbFile);
  parentPort?.postMessage({ records });
} catch (error) {
  const message = error instanceof Error ? error.message.replace(/Bearer\s+\S+/gi, 'Bearer [hidden]') : 'Unexpected worker error';
  parentPort?.postMessage({ error: message });
}
