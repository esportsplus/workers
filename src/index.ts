import type { Actions } from './onmessage';
import { priority } from './schedule';
import type { Comparator, PriorityScheduler, WorkerContext } from './types';
import onmessage from './onmessage';
import pool from './pool';


export default { onmessage, pool, priority };
export { onmessage, pool, priority };
export type { Actions, Comparator, PriorityScheduler, WorkerContext };