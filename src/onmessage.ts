export default (actions: object, worker: Worker) => {
    worker.onmessage = async (e) => {
        let [path, values] = e.data,
            action: any = actions;

        for (let i = 0, n = path.length; i < n; i++) {
            action = action[path[i]] || {};
        }

        if (typeof action !== 'function') {
            throw new Error(`Path does not exist '${path}'`);
        }

        worker.postMessage( await action(...values) );
    };
};