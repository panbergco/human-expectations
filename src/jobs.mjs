import { Worker } from 'node:worker_threads';

// Each job is bounded by its input. Never terminate a worker midway through an atomic state update.
export function runJob(job) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.mjs', import.meta.url), { workerData: job, execArgv: [] });
    let answered = false;
    worker.once('message', message => {
      answered = true;
      if (message.ok) resolve(message.value); else reject(Error(message.error));
    });
    worker.once('error', reject);
    worker.once('exit', code => { if (!answered) reject(Error(`Expectation worker exited ${code} without a result`)); });
  });
}
