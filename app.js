const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_PIXELS = 8_000_000;

const dropzone = document.querySelector("#dropzone");
const fileInput = document.querySelector("#file-input");
const editor = document.querySelector("#editor");
const status = document.querySelector("#status");
const originalCanvas = document.querySelector("#original-canvas");
const resultCanvas = document.querySelector("#result-canvas");
const originalSize = document.querySelector("#original-size");
const resultSize = document.querySelector("#result-size");
const range = document.querySelector("#blur-range");
const blurValue = document.querySelector("#blur-value");
const processing = document.querySelector("#processing");
const saveButton = document.querySelector("#save-button");

let sourceImage = null;
let sourceName = "image";
let renderTicket = 0;
let renderTimer = 0;
const wasmReady = fetch(new URL("./gaussian_blur.wasm", import.meta.url))
  .then(response => {
    if (!response.ok) throw new Error(`WASM load failed: ${response.status}`);
    return response.arrayBuffer();
  })
  .then(bytes => WebAssembly.instantiate(bytes, {}))
  .then(({ instance }) => instance.exports);

function setStatus(message, isError = false) {
  status.textContent = message;
  status.classList.toggle("error", isError);
}

function isPng(file) {
  return file.type === "image/png" || file.name.toLowerCase().endsWith(".png");
}

function drawContained(canvas, image) {
  const maxWidth = Math.max(1, canvas.parentElement.clientWidth - 24);
  const maxHeight = Math.max(1, canvas.parentElement.clientHeight - 24);
  const scale = Math.min(1, maxWidth / image.width, maxHeight / image.height);
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0);
  fitCanvas(canvas, scale);
}

function fitCanvas(canvas) {
  const maxWidth = Math.max(1, canvas.parentElement.clientWidth - 24);
  const maxHeight = Math.max(1, canvas.parentElement.clientHeight - 24);
  const scale = Math.min(1, maxWidth / canvas.width, maxHeight / canvas.height);
  canvas.style.width = `${Math.round(canvas.width * scale)}px`;
  canvas.style.height = `${Math.round(canvas.height * scale)}px`;
}

async function openPng(file) {
  if (!file) return;
  if (!isPng(file)) return setStatus("PNGファイルを選んでください。", true);
  if (file.size > MAX_FILE_BYTES) return setStatus("ファイルサイズは20 MB以下にしてください。", true);

  let image;
  try {
    image = await createImageBitmap(file);
  } catch {
    return setStatus("このPNGを読み込めませんでした。別のファイルをお試しください。", true);
  }
  if (image.width * image.height > MAX_PIXELS) {
    image.close();
    return setStatus("処理負荷を抑えるため、画像は800万画素以下にしてください。", true);
  }

  sourceImage?.close();
  sourceImage = image;
  sourceName = file.name.replace(/\.png$/i, "") || "image";
  drawContained(originalCanvas, sourceImage);
  originalSize.textContent = `${image.width} × ${image.height}`;
  resultSize.textContent = `${image.width} × ${image.height}`;
  editor.hidden = false;
  dropzone.hidden = true;
  range.value = "8";
  blurValue.value = "8 px";
  setStatus(`${file.name} を読み込みました。画像データはこの端末から送信されません。`);
  scheduleRender(0);
}

async function gaussianBlur(imageData, sigma) {
  if (sigma <= 0) return new ImageData(new Uint8ClampedArray(imageData.data), imageData.width, imageData.height);
  const { width, height, data } = imageData;
  const exports = await wasmReady;
  const memory = exports.memory;
  const heapBase = Number(exports.__heap_base.value);
  const pixelBytes = data.length;
  const firstOffset = (heapBase + 15) & ~15;
  const secondOffset = (firstOffset + pixelBytes + 15) & ~15;
  const requiredBytes = secondOffset + pixelBytes;
  if (requiredBytes > memory.buffer.byteLength) {
    memory.grow(Math.ceil((requiredBytes - memory.buffer.byteLength) / 65536));
  }
  const heap = new Uint8Array(memory.buffer);
  heap.set(data, firstOffset);
  const outputIndex = exports.blur_rgba(firstOffset, secondOffset, width, height, sigma);
  if (outputIndex < 0) throw new Error("WASM rejected the image buffer");
  const outputOffset = outputIndex === 0 ? firstOffset : secondOffset;
  const output = new Uint8ClampedArray(pixelBytes);
  output.set(new Uint8Array(memory.buffer, outputOffset, pixelBytes));
  return new ImageData(output, width, height);
}

function scheduleRender(delay = 100) {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => renderBlur(), delay);
}

async function renderBlur() {
  if (!sourceImage) return;
  const ticket = ++renderTicket;
  const sigma = Number(range.value);
  blurValue.value = `${sigma} px`;
  processing.hidden = false;
  saveButton.disabled = true;
  await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
  try {
    const context = resultCanvas.getContext("2d", { willReadFrequently: true });
    resultCanvas.width = sourceImage.width;
    resultCanvas.height = sourceImage.height;
    context.drawImage(sourceImage, 0, 0);
    const originalPixels = context.getImageData(0, 0, resultCanvas.width, resultCanvas.height);
    const blurred = await gaussianBlur(originalPixels, sigma);
    if (ticket !== renderTicket) return;
    context.putImageData(blurred, 0, 0);
    fitCanvas(resultCanvas);
    setStatus(sigma === 0 ? "元画像を表示しています。" : `ガウスブラーを適用しました（σ ${sigma} px）。`);
  } catch (error) {
    setStatus(error?.name === "SecurityError" ? "画像を処理できませんでした。" : "画像の処理中にエラーが発生しました。", true);
  } finally {
    if (ticket === renderTicket) {
      processing.hidden = true;
      saveButton.disabled = false;
    }
  }
}

wasmReady.then(() => {
  if (!sourceImage) setStatus("PNG画像を選ぶと、ここにプレビューが表示されます。");
}).catch(() => setStatus("WASMを読み込めませんでした。ページをHTTPサーバー経由で開いてください。", true));

function resetEditor() {
  sourceImage?.close();
  sourceImage = null;
  originalCanvas.width = originalCanvas.height = 0;
  resultCanvas.width = resultCanvas.height = 0;
  fileInput.value = "";
  editor.hidden = true;
  dropzone.hidden = false;
  setStatus("PNG画像を選ぶと、ここにプレビューが表示されます。");
}

dropzone.addEventListener("click", event => {
  if (event.target !== fileInput) fileInput.click();
});
dropzone.addEventListener("keydown", event => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    fileInput.click();
  }
});
fileInput.addEventListener("change", () => openPng(fileInput.files?.[0]));
for (const eventName of ["dragenter", "dragover"]) {
  dropzone.addEventListener(eventName, event => {
    event.preventDefault();
    dropzone.classList.add("dragging");
  });
}
for (const eventName of ["dragleave", "drop"]) {
  dropzone.addEventListener(eventName, event => {
    event.preventDefault();
    dropzone.classList.remove("dragging");
  });
}
dropzone.addEventListener("drop", event => openPng(event.dataTransfer?.files?.[0]));
range.addEventListener("input", () => {
  blurValue.value = `${range.value} px`;
  scheduleRender(80);
});
document.querySelector("#choose-another").addEventListener("click", resetEditor);
saveButton.addEventListener("click", () => {
  if (!sourceImage) return;
  resultCanvas.toBlob(blob => {
    if (!blob) return setStatus("PNGを書き出せませんでした。", true);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${sourceName}-blur-${range.value}px.png`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus("ぼかしたPNGを保存しました。");
  }, "image/png");
});
