import { Packr, Unpackr } from 'msgpackr';


let packr = new Packr({
        structuredClone: true,
        useRecords: false,
    }),
    unpackr = new Unpackr({
        structuredClone: true,
        useRecords: false,
    });


const decode = (buffer: ArrayBuffer): any => {
    return unpackr.unpack(new Uint8Array(buffer));
}

const encode = (data: any): ArrayBuffer => {
    return packr.pack(data).buffer as ArrayBuffer;
}


export { decode, encode };