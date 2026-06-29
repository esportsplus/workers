import { WorkerLike, WorkerPort } from '../types';


const cores = (): number => navigator.hardwareConcurrency;

const spawn = (url: string): WorkerLike => new Worker(url, { type: 'module' }) as unknown as WorkerLike;

const workerPort = (): WorkerPort | null => null;


export { cores, spawn, workerPort };
