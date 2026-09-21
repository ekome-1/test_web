// Raicho self-host std_web loader and browser glue.
const wasmUrl = new URL("homepage.wasm", import.meta.url);

function documentOrThrow() {
    if (typeof document === "undefined") throw new Error("std_web browser APIs require a document.");
    return document;
}

function resolveElement(target) {
    if (typeof target !== "string") return target;
    const doc = documentOrThrow();
    return doc.getElementById(target) ??
        ((target.startsWith("#") || target.startsWith(".")) ? doc.querySelector(target) : null);
}

function elementOrThrow(target) {
    const element = resolveElement(target);
    if (!element) throw new Error(`std_web element not found: ${String(target)}`);
    return element;
}

export function getInputValue(target) { return String(elementOrThrow(target).value ?? ""); }
export function setInputValue(target, value) { elementOrThrow(target).value = String(value ?? ""); }
export function getText(target) { return String(elementOrThrow(target).textContent ?? ""); }
export function setText(target, value) { elementOrThrow(target).textContent = String(value ?? ""); }
export function downloadText(filename, value, mimeType = "text/plain;charset=utf-8") {
    const blob = new Blob([String(value ?? "")], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = documentOrThrow().createElement("a");
    link.href = url;
    link.download = String(filename ?? "download.txt");
    link.click();
    URL.revokeObjectURL(url);
}
export function downloadUrl(url, filename = "download") {
    const link = documentOrThrow().createElement("a");
    link.href = String(url);
    link.download = String(filename);
    link.rel = "noopener";
    link.click();
}
export function downloadBytes(filename, bytes, mimeType = "application/octet-stream") {
    const blob = new Blob([bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = documentOrThrow().createElement("a");
    link.href = url; link.download = String(filename ?? "download.bin"); link.click();
    URL.revokeObjectURL(url);
}
export function downloadBase64(filename, base64, mimeType = "application/octet-stream") {
    const binary = atob(String(base64 ?? ""));
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    downloadBytes(filename, bytes, mimeType);
}

export function onInput(target, handler) {
    const element = elementOrThrow(target);
    const listener = event => handler(getInputValue(element), event);
    element.addEventListener("input", listener);
    return () => element.removeEventListener("input", listener);
}

export function onClick(target, handler) {
    const element = elementOrThrow(target);
    const listener = event => handler(event);
    element.addEventListener("click", listener);
    return () => element.removeEventListener("click", listener);
}

export function onKeyDown(target, handler) {
    const element = elementOrThrow(target);
    const listener = event => handler(event.key, event);
    element.addEventListener("keydown", listener);
    return () => element.removeEventListener("keydown", listener);
}

export function onDrop(target, handler) {
    const element = elementOrThrow(target);
    if (typeof handler !== "function") throw new TypeError("std_web onDrop handler must be a function.");
    const dragOver = event => {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const drop = event => {
        event.preventDefault();
        handler(Array.from(event.dataTransfer?.files ?? []), event);
    };
    element.addEventListener("dragover", dragOver);
    element.addEventListener("drop", drop);
    return () => {
        element.removeEventListener("dragover", dragOver);
        element.removeEventListener("drop", drop);
    };
}

export async function readFileText(file, encoding = "utf-8") {
    if (!file || typeof file.arrayBuffer !== "function") throw new TypeError("std_web readFileText requires a File or Blob.");
    return new TextDecoder(encoding).decode(await file.arrayBuffer());
}

export async function readFileBytes(file) {
    if (!file || typeof file.arrayBuffer !== "function") throw new TypeError("std_web readFileBytes requires a File or Blob.");
    return new Uint8Array(await file.arrayBuffer());
}

export function element(target) { return elementOrThrow(target); }

const stdinQueue = [];
let stdinBytes = new Uint8Array();
export function setStdin(value) { stdinQueue.push(String(value ?? "") + "\n"); }

export const stdWeb = Object.freeze({
    getInputValue, setInputValue, getText, setText,
    downloadText, downloadUrl, downloadBytes, downloadBase64,
    onInput, onClick, onKeyDown, onDrop, readFileText, readFileBytes, element, setStdin
});
if (typeof globalThis !== "undefined") globalThis.RaichoStdWeb = stdWeb;

class RaichoWasmExit extends Error {
    constructor(code) { super(`Raicho WASM exited with code ${code}.`); this.code = code; }
}

function createWasi(getInstance) {
    const view = () => {
        const memory = getInstance()?.exports.memory;
        if (!memory) throw new Error("std_web WASI memory is not available.");
        return new DataView(memory.buffer);
    };
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const refill = () => {
        if (stdinBytes.length) return true;
        if (stdinQueue.length) { stdinBytes = encoder.encode(stdinQueue.shift()); return true; }
        if (typeof globalThis.prompt === "function") {
            const value = globalThis.prompt("Raicho Input");
            if (value === null) return false;
            stdinBytes = encoder.encode(value + "\n");
            return true;
        }
        return false;
    };
    return {
        args_sizes_get: (argc, size) => { const memory = view(); memory.setUint32(argc, 0, true); memory.setUint32(size, 0, true); return 0; },
        args_get: () => 0,
        fd_read: (fd, iovs, count, read) => {
            const memory = view();
            if (fd !== 0) { memory.setUint32(read, 0, true); return 8; }
            if (!refill()) { memory.setUint32(read, 0, true); return 0; }
            const bytes = new Uint8Array(memory.buffer);
            let total = 0;
            for (let index = 0; index < count && stdinBytes.length; index++) {
                const pointer = memory.getUint32(iovs + index * 8, true);
                const length = memory.getUint32(iovs + index * 8 + 4, true);
                const copied = Math.min(length, stdinBytes.length);
                bytes.set(stdinBytes.subarray(0, copied), pointer);
                stdinBytes = stdinBytes.subarray(copied);
                total += copied;
            }
            memory.setUint32(read, total, true);
            return 0;
        },
        fd_close: () => 0,
        fd_seek: () => 0,
        fd_write: (fd, iovs, count, written) => {
            const memory = view();
            if (fd !== 1 && fd !== 2) { memory.setUint32(written, 0, true); return 8; }
            const bytes = new Uint8Array(memory.buffer);
            let output = "";
            let total = 0;
            for (let index = 0; index < count; index++) {
                const pointer = memory.getUint32(iovs + index * 8, true);
                const length = memory.getUint32(iovs + index * 8 + 4, true);
                output += decoder.decode(bytes.subarray(pointer, pointer + length), { stream: true });
                total += length;
            }
            output += decoder.decode();
            memory.setUint32(written, total, true);
            (fd === 2 ? console.error : console.log)(output.endsWith("\n") ? output.slice(0, -1) : output);
            return 0;
        },
        proc_exit: code => { throw new RaichoWasmExit(code); }
    };
}

export async function loadRaichoWasm(url = wasmUrl, imports = {}) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to load Raicho WASM: ${response.status}`);
    const bytes = await response.arrayBuffer();
    let instance;
    const wasi = createWasi(() => instance);
    const merged = { ...imports, wasi_snapshot_preview1: { ...wasi, ...(imports.wasi_snapshot_preview1 ?? {}) } };
    const result = await WebAssembly.instantiate(bytes, merged);
    instance = result.instance;
    return instance;
}

export async function main(url = wasmUrl, imports = {}) {
    const instance = await loadRaichoWasm(url, imports);
    const entry = instance.exports._start ?? instance.exports.main ?? instance.exports.__main_argc_argv;
    if (typeof entry !== "function") throw new Error("std_web WASM entry point was not found.");
    try { return entry(); }
    catch (error) { if (error instanceof RaichoWasmExit) return error.code; throw error; }
}
