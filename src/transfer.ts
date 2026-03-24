function collectTransferables(value: unknown): Transferable[] {
    let result: Transferable[] = [],
        stack = [value];

    while (stack.length > 0) {
        let current = stack.pop();

        if (!current || typeof current !== 'object') {
            continue;
        }

        if (current instanceof ArrayBuffer ||
            current instanceof MessagePort ||
            (typeof AudioData !== 'undefined' && current instanceof AudioData) ||
            (typeof ImageBitmap !== 'undefined' && current instanceof ImageBitmap) ||
            (typeof MediaSourceHandle !== 'undefined' && current instanceof MediaSourceHandle) ||
            (typeof OffscreenCanvas !== 'undefined' && current instanceof OffscreenCanvas) ||
            (typeof RTCDataChannel !== 'undefined' && current instanceof RTCDataChannel) ||
            (typeof ReadableStream !== 'undefined' && current instanceof ReadableStream) ||
            (typeof TransformStream !== 'undefined' && current instanceof TransformStream) ||
            (typeof VideoFrame !== 'undefined' && current instanceof VideoFrame) ||
            (typeof WritableStream !== 'undefined' && current instanceof WritableStream)) {
            result.push(current as Transferable);
            continue;
        }

        if (Array.isArray(current)) {
            for (let i = 0, n = current.length; i < n; i++) {
                if (current[i] && typeof current[i] === 'object') {
                    stack.push(current[i]);
                }
            }
        }
        else {
            for (let key in current) {
                let value = (current as Record<string, unknown>)[key];

                if (value && typeof value === 'object') {
                    stack.push(value);
                }
            }
        }
    }

    return result;
}


export { collectTransferables };
