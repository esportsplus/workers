import { Infer } from './types';


let available = navigator.hardwareConcurrency - 1 || 1;


class Pool {
    private available: number[] = [];
    private limit: number;
    private url: string;
    private workers: Worker[] = [];


    constructor(url: string, limit?: number) {
        this.limit = available;
        this.url = url;

        if (limit && this.limit > limit) {
            this.limit = limit;
        }

        available -= this.limit;

        if (available < 0) {
            throw new Error('Workers pool exceeded max capacity!');
        }
    }


    private manage(worker: Worker) {
        let index = this.workers.indexOf(worker);

        if (this.workers.length > this.limit) {
            this.workers.splice(index, 1)[0]?.terminate();
        }
        else {
            this.available.push(index);
        }
    }

    async schedule(path: string[], values: any[]) {
        if (this.limit <= this.workers.length) {
            await Promise.race(this.workers);
        }

        let worker = this.workers[this.available.shift() || -1] || new Worker(this.url);

        return new Promise((resolve, reject) => {
            worker.onmessage = (e) => {
                this.manage(worker);
                resolve(e.data);
            };

            worker.onerror = (e) => {
                this.manage(worker);
                reject(e.message);
            };

            worker.postMessage({ action: [path, values] });
        });
    }
}


export default <T extends object>(url: string, limit?: number) => {
    let pool = new Pool(url, limit);

    return (): Infer<T> => new Proxy(
        Object.assign(() => {}, { path: [] }),
        {
            apply: (target: any, __, values: any[]) => {
                Object.freeze(target.path);

                return pool.schedule(target.path, values);
            },
            deleteProperty: () => true,
            get: (target: any, key: string, receiver) => {
                if (key === 'path') {
                    return Reflect.get(target, key);
                }

                target.path.push(key);

                return receiver;
            },
            set: () => true
        }
    );
};