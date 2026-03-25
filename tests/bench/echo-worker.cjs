'use strict';

const { parentPort } = require('worker_threads');

parentPort.on('message', (data) => {
    if (!data || !data.uuid) {
        return;
    }

    if (data.release) {
        parentPort.postMessage({ result: undefined, uuid: data.uuid });
        return;
    }

    // Echo first arg as result
    parentPort.postMessage({ result: data.args ? data.args[0] : null, uuid: data.uuid });
});
