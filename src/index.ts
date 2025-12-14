import onmessage from './onmessage';
import pool from './pool';
import type { Actions } from './onmessage';
import type { WorkerContext } from './types';


export default { onmessage, pool };
export { onmessage, pool };
export type { Actions, WorkerContext };