let objectProto = Object.getPrototypeOf({}) as object;


function hasOnlyPrimitiveValues(obj: Record<string, unknown>): boolean {
    for (let key in obj) {
        let v = obj[key];

        if (v && typeof v === 'object') {
            return false;
        }
    }

    return true;
}

function isAllPrimitive(arr: unknown[]): boolean {
    for (let i = 0, n = arr.length; i < n; i++) {
        let v = arr[i];

        if (v && typeof v === 'object') {
            return false;
        }
    }

    return true;
}

function isTransferable(v: object): boolean {
    return v instanceof ArrayBuffer ||
        v instanceof MessagePort ||
        (typeof AudioData !== 'undefined' && v instanceof AudioData) ||
        (typeof ImageBitmap !== 'undefined' && v instanceof ImageBitmap) ||
        (typeof MediaSourceHandle !== 'undefined' && v instanceof MediaSourceHandle) ||
        (typeof OffscreenCanvas !== 'undefined' && v instanceof OffscreenCanvas) ||
        (typeof RTCDataChannel !== 'undefined' && v instanceof RTCDataChannel) ||
        (typeof ReadableStream !== 'undefined' && v instanceof ReadableStream) ||
        (typeof TransformStream !== 'undefined' && v instanceof TransformStream) ||
        (typeof VideoFrame !== 'undefined' && v instanceof VideoFrame) ||
        (typeof WritableStream !== 'undefined' && v instanceof WritableStream);
}

function collectTransferables(value: unknown): Transferable[] {
    // Fast-path: primitives (null, undefined, boolean, number, string, bigint, symbol)
    if (!value || typeof value !== 'object') {
        return [];
    }

    // Fast-path: shallow primitive-only arrays
    if (Array.isArray(value) && isAllPrimitive(value)) {
        return [];
    }

    // Fast-path: shallow primitive-only plain objects
    if (!Array.isArray(value)) {
        let proto = Object.getPrototypeOf(value) as object | null;

        if ((proto === objectProto || proto === null) && hasOnlyPrimitiveValues(value as Record<string, unknown>)) {
            return [];
        }
    }

    if (isTransferable(value)) {
        return [value as Transferable];
    }

    let result: Transferable[] = [],
        seen: WeakSet<object> | null = null,
        stack = [value];

    while (stack.length > 0) {
        let current = stack.pop() as object;

        if (seen !== null && seen.has(current)) {
            continue;
        }

        if (seen !== null) {
            seen.add(current);
        }

        if (Array.isArray(current)) {
            for (let i = 0, n = current.length; i < n; i++) {
                let child = current[i];

                if (child && typeof child === 'object') {
                    if (isTransferable(child)) {
                        result.push(child as Transferable);
                    }
                    else {
                        if (seen === null) {
                            seen = new WeakSet();
                            seen.add(current);
                        }

                        stack.push(child);
                    }
                }
            }
        }
        else {
            for (let key in current) {
                let child = (current as Record<string, unknown>)[key];

                if (child && typeof child === 'object') {
                    if (isTransferable(child as object)) {
                        result.push(child as Transferable);
                    }
                    else {
                        if (seen === null) {
                            seen = new WeakSet();
                            seen.add(current);
                        }

                        stack.push(child);
                    }
                }
            }
        }
    }

    if (result.length > 1) {
        result = Array.from(new Set(result));
    }

    return result;
}


export { collectTransferables };
