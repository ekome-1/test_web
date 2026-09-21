const MAX_DISCOVERED = 1500;

function appendPath(parent, name) {
    return parent ? `${parent}/${name}` : name;
}

async function walkHandle(handle, parentPath, collected, depth = 0) {
    if (depth > 40 || collected.length >= MAX_DISCOVERED) throw new Error("フォルダが深すぎるか、ファイル数が多すぎます。");
    if (handle.kind === "file") {
        const file = await handle.getFile();
        collected.push({ file, path: appendPath(parentPath, handle.name) });
        return;
    }
    if (handle.kind === "directory") {
        for await (const child of handle.values()) {
            await walkHandle(child, appendPath(parentPath, handle.name), collected, depth + 1);
        }
    }
}

function readEntryFile(entry) {
    return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function readDirectoryEntries(entry) {
    const reader = entry.createReader();
    return new Promise((resolve, reject) => {
        const all = [];
        const readBatch = () => reader.readEntries(batch => {
            if (batch.length === 0) resolve(all);
            else { all.push(...batch); readBatch(); }
        }, reject);
        readBatch();
    });
}

async function walkEntry(entry, parentPath, collected, depth = 0) {
    if (depth > 40 || collected.length >= MAX_DISCOVERED) throw new Error("フォルダが深すぎるか、ファイル数が多すぎます。");
    const path = appendPath(parentPath, entry.name);
    if (entry.isFile) {
        collected.push({ file: await readEntryFile(entry), path });
    } else if (entry.isDirectory) {
        const children = await readDirectoryEntries(entry);
        for (const child of children) await walkEntry(child, path, collected, depth + 1);
    }
}

export async function collectDroppedFiles(event) {
    const collected = [];
    const items = Array.from(event.dataTransfer?.items ?? []);
    for (const item of items) {
        let handled = false;
        if (typeof item.getAsFileSystemHandle === "function") {
            let handle = null;
            try {
                handle = await item.getAsFileSystemHandle();
            } catch { /* Try the older WebKit entry API below. */ }
            if (handle) { await walkHandle(handle, "", collected); handled = true; }
        }
        if (!handled && typeof item.webkitGetAsEntry === "function") {
            const entry = item.webkitGetAsEntry();
            if (entry) { await walkEntry(entry, "", collected); handled = true; }
        }
        if (!handled && item.kind === "file") {
            const file = item.getAsFile();
            if (file) collected.push({ file, path: file.webkitRelativePath || file.name });
        }
        if (collected.length > MAX_DISCOVERED) throw new Error("フォルダ内のファイルが多すぎます。");
    }
    if (collected.length === 0) {
        for (const file of Array.from(event.dataTransfer?.files ?? [])) {
            collected.push({ file, path: file.webkitRelativePath || file.name });
        }
    }
    if (collected.length > MAX_DISCOVERED) throw new Error("フォルダ内のファイルが多すぎます。");
    return collected;
}
