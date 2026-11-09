import { SamModel, AutoProcessor, RawImage, Tensor, env } from '../node_modules/@huggingface/transformers/dist/transformers.min.js';

const MODEL_ID = 'Xenova/slimsam-77-uniform';
const MIRROR_HOST = 'https://hf-mirror.com/';
const MAX_SIDE = 1024;
const MAX_FULL_SIDE = 4096;
const CROP_MARGIN = 0.15;
const MIN_REFINE_IOU = 0.5;
const MAX_UNDO = 20;
const MAX_OBJECTS = 12;
const STALL_MS = 30000;
const MAX_BASE_SIDE = 1024;
const BOX_MARGIN = 0.08;
const SMALL_CHILD_RATIO = 0.05;
const EYE_HOLE_GROW = 1.3;
const LARGE_OBJECT_AREA = 0.08;
const TINY_OBJECT_AREA = 0.02;
const AROUND_BOX_GAP = 0.3;
const ACTIONS = [
  ['', '自动（呼吸）'],
  ['breathe', '呼吸'],
  ['sway', '摇摆'],
  ['nod', '点头'],
  ['peek', '探头'],
  ['hop', '蹦跳'],
  ['float', '漂浮'],
  ['wiggle', '抖动'],
  ['crawl', '爬·身体'],
  ['crawlHandA', '爬·先迈的手'],
  ['crawlHandB', '爬·后迈的手'],
  ['blink', '眨眼'],
  ['wink', '单独眨眼'],
  ['teeter', '摇摇欲坠'],
  ['write', '写字'],
  ['still', '不动'],
];

// 优先读项目 models/ 目录，没有再联网下载。
env.allowLocalModels = true;
env.localModelPath = new URL('../models/', location.href).href;
env.backends.onnx.wasm.wasmPaths = new URL('../node_modules/onnxruntime-web/dist/', location.href).href;

const canvas = document.getElementById('canvas');
const context = canvas.getContext('2d');
const statusEl = document.getElementById('status');
const undoButton = document.getElementById('undo');
const clearButton = document.getElementById('clear');
const nextRangeButton = document.getElementById('next-range');
const addButton = document.getElementById('add');
const saveButton = document.getElementById('save');
const cutoutsEl = document.getElementById('cutouts');
const countEl = document.getElementById('count');
const nameInput = document.getElementById('name');
const autoButton = document.getElementById('auto');
const autoHint = document.getElementById('auto-hint');
const keepRestInput = document.getElementById('keep-rest');
const titleEl = document.getElementById('title');
const pickTools = document.getElementById('pick-tools');
const touchTools = document.getElementById('touch-tools');
const brushSizeInput = document.getElementById('brush-size');
const touchUndoButton = document.getElementById('touch-undo');
const touchDoneButton = document.getElementById('touch-done');

const source = document.createElement('canvas');
const full = document.createElement('canvas');
const backgroundless = document.createElement('canvas');
const overlay = document.createElement('canvas');

let width = 0;
let height = 0;
let fullWidth = 0;
let fullHeight = 0;
let model = null;
let processor = null;
let inputs = null;
let embeddings = null;
let points = [];
let candidates = [];
let candidateOrder = [];
let rank = 0;
let currentMask = null;
let requestId = 0;
let ready = false;
let touch = null;
let visionConfigured = false;
let recognizing = false;
let hintBox = null;
const cutouts = [];

function setAutoHint() {
  autoHint.textContent = visionConfigured
    ? '图片会上传给模型服务来判断姿势。也可以直接手动选。'
    : '设置 API Key 后可以自动识别，现在可以手动选。';
}

function setStatus(text) {
  statusEl.textContent = text;
}

// 让状态文字先显示出来，再开始占用 CPU 的计算。
// 不能用 requestAnimationFrame：窗口被挡住或切到后台时它会暂停，计算就卡住了。
const letStatusPaint = () => new Promise((resolve) => setTimeout(resolve, 50));

function updateButtons() {
  undoButton.disabled = !points.length;
  clearButton.disabled = !points.length;
  nextRangeButton.disabled = candidateOrder.length < 2;
  addButton.disabled = !currentMask || cutouts.length >= MAX_OBJECTS || recognizing;
  autoButton.disabled = !ready || !visionConfigured || recognizing || Boolean(touch);
  saveButton.disabled = !cutouts.length || Boolean(touch);
  countEl.textContent = String(cutouts.length);
}

async function loadModel() {
  const files = new Map();
  let lastProgress = Date.now();
  const stallTimer = setInterval(() => {
    if (Date.now() - lastProgress < STALL_MS) return;
    setStatus('下载好像卡住了。可以再等等，或关闭窗口重试，也可以按 README 手动把模型放进 models 文件夹');
  }, 1000);
  const options = {
    progress_callback: (progress) => {
      if (progress.status !== 'progress' || !progress.total) return;
      lastProgress = Date.now();
      files.set(progress.file, progress);
      let loaded = 0;
      let total = 0;
      for (const file of files.values()) {
        loaded += file.loaded;
        total += file.total;
      }
      setStatus(`正在准备分割模型：${Math.round((loaded / total) * 100)}%（源码运行时首次要下载约 38MB）`);
    },
  };
  const load = async () => {
    processor = await AutoProcessor.from_pretrained(MODEL_ID);
    model = await SamModel.from_pretrained(MODEL_ID, { ...options, dtype: 'fp32', device: 'wasm' });
  };
  try {
    await load();
  } catch {
    // 部分网络访问不了 Hugging Face，换国内镜像再试一次。
    files.clear();
    env.remoteHost = MIRROR_HOST;
    try {
      await load();
    } catch {
      throw new Error('模型下载失败。请检查网络，或按 README 手动把模型放进 models 文件夹');
    }
  } finally {
    clearInterval(stallTimer);
  }
}

function drawStage() {
  context.clearRect(0, 0, width, height);
  context.drawImage(source, 0, 0);
  if (currentMask) context.drawImage(overlay, 0, 0);
  const radius = Math.max(5, Math.round(Math.max(width, height) / 130));
  for (const point of points) {
    context.beginPath();
    context.arc(point.x, point.y, radius, 0, Math.PI * 2);
    context.fillStyle = point.label === 1 ? '#16a34a' : '#dc2626';
    context.fill();
    context.lineWidth = Math.max(2, radius / 3);
    context.strokeStyle = '#fff';
    context.stroke();
  }
}

// 被选中的部分保持原样，其余部分压暗。
function buildOverlay() {
  overlay.width = width;
  overlay.height = height;
  const overlayContext = overlay.getContext('2d');
  const image = overlayContext.createImageData(width, height);
  for (let i = 0; i < width * height; i += 1) {
    const offset = i * 4;
    image.data[offset] = 15;
    image.data[offset + 1] = 23;
    image.data[offset + 2] = 42;
    image.data[offset + 3] = currentMask[i] ? 0 : 165;
  }
  overlayContext.putImageData(image, 0, 0);
}

function selectCandidate() {
  if (!candidateOrder.length) {
    currentMask = null;
    drawStage();
    updateButtons();
    return;
  }
  const mask = candidates[candidateOrder[rank % candidateOrder.length]];
  currentMask = cleanMask(mask, width, height, points);
  buildOverlay();
  drawStage();
  updateButtons();
}

// 按给定的点跑一次解码器，返回每个候选的 0/1 蒙版和分数。
async function decode(imageInputs, imageEmbeddings, imagePoints, imageWidth, imageHeight) {
  const [reshapedHeight, reshapedWidth] = imageInputs.reshaped_input_sizes[0];
  const flat = imagePoints.flatMap((point) => [
    (point.x / imageWidth) * reshapedWidth,
    (point.y / imageHeight) * reshapedHeight,
  ]);
  const input_points = new Tensor('float32', flat, [1, 1, imagePoints.length, 2]);
  const input_labels = new Tensor(
    'int64',
    imagePoints.map((point) => BigInt(point.label)),
    [1, 1, imagePoints.length],
  );
  const outputs = await model({ ...imageEmbeddings, input_points, input_labels });
  const processed = await processor.post_process_masks(
    outputs.pred_masks,
    imageInputs.original_sizes,
    imageInputs.reshaped_input_sizes,
  );
  const data = processed[0].data;
  const count = processed[0].dims[1];
  const size = imageWidth * imageHeight;
  return {
    masks: Array.from({ length: count }, (_, index) => Uint8Array.from(data.subarray(index * size, (index + 1) * size))),
    scores: Array.from(outputs.iou_scores.data),
  };
}

async function segment() {
  const id = (requestId += 1);
  if (!points.length) {
    candidates = [];
    candidateOrder = [];
    currentMask = null;
    drawStage();
    updateButtons();
    return;
  }
  const { masks, scores } = await decode(inputs, embeddings, points, width, height);
  if (id !== requestId) return;
  candidates = masks;
  candidateOrder = rankMasks(candidates, width, scores, points);
  rank = 0;
  selectCandidate();
}

function clearSelection() {
  points = [];
  segment();
}

function addPoint(event, label) {
  if (!ready) return;
  const box = canvas.getBoundingClientRect();
  const x = Math.round(((event.clientX - box.left) / box.width) * (width - 1));
  const y = Math.round(((event.clientY - box.top) / box.height) * (height - 1));
  points.push({ x, y, label });
  drawStage();
  segment().catch(showError);
}

function maskBounds(mask, maskWidth, maskHeight) {
  let minX = maskWidth;
  let minY = maskHeight;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < maskHeight; y += 1) {
    for (let x = 0; x < maskWidth; x += 1) {
      if (!mask[y * maskWidth + x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return maxX < 0 ? null : { minX, minY, maxX, maxY };
}

// 分割模型的框提示：左上角和右下角分别用标签 2 和 3 表示。
function boxPrompt(box) {
  if (!box) return [];
  return [
    { x: box.left, y: box.top, label: 2 },
    { x: box.right, y: box.bottom, label: 3 },
  ];
}

// 整张图的蒙版分辨率有限，小对象只分到几十个像素，所以把对象所在区域
// 从原图裁出来再分割一次，然后让边界贴合原图的颜色边缘。
async function cutOut() {
  const bounds = maskBounds(currentMask, width, height);
  if (!bounds) return null;

  const toFull = fullWidth / width;
  const objectWidth = (bounds.maxX - bounds.minX + 1) * toFull;
  const objectHeight = (bounds.maxY - bounds.minY + 1) * toFull;
  const margin = Math.max(objectWidth, objectHeight) * CROP_MARGIN;
  const cropLeft = Math.max(0, Math.floor(bounds.minX * toFull - margin));
  const cropTop = Math.max(0, Math.floor(bounds.minY * toFull - margin));
  const cropRight = Math.min(fullWidth, Math.ceil((bounds.maxX + 1) * toFull + margin));
  const cropBottom = Math.min(fullHeight, Math.ceil((bounds.maxY + 1) * toFull + margin));
  const shrink = Math.min(1, MAX_SIDE / Math.max(cropRight - cropLeft, cropBottom - cropTop));
  const cropWidth = Math.round((cropRight - cropLeft) * shrink);
  const cropHeight = Math.round((cropBottom - cropTop) * shrink);

  const crop = document.createElement('canvas');
  crop.width = cropWidth;
  crop.height = cropHeight;
  const cropContext = crop.getContext('2d', { willReadFrequently: true });
  cropContext.drawImage(full, cropLeft, cropTop, cropRight - cropLeft, cropBottom - cropTop, 0, 0, cropWidth, cropHeight);
  const cropPixels = cropContext.getImageData(0, 0, cropWidth, cropHeight).data;

  const toCrop = (x, y) => ({
    x: Math.max(0, Math.min(cropWidth - 1, Math.round((x * toFull - cropLeft) * shrink))),
    y: Math.max(0, Math.min(cropHeight - 1, Math.round((y * toFull - cropTop) * shrink))),
  });
  const cropPoints = points.map((point) => ({ ...toCrop(point.x, point.y), label: point.label }));
  const cropBox = hintBox && {
    left: toCrop(hintBox.left * (width - 1), 0).x,
    right: toCrop(hintBox.right * (width - 1), 0).x,
    top: toCrop(0, hintBox.top * (height - 1)).y,
    bottom: toCrop(0, hintBox.bottom * (height - 1)).y,
  };

  // 预览蒙版映射到裁切区域，用来判断重新分割的结果有没有跑偏。
  const preview = new Uint8Array(cropWidth * cropHeight);
  for (let y = 0; y < cropHeight; y += 1) {
    const sourceY = Math.min(height - 1, Math.floor((y / shrink + cropTop) / toFull));
    for (let x = 0; x < cropWidth; x += 1) {
      const sourceX = Math.min(width - 1, Math.floor((x / shrink + cropLeft) / toFull));
      preview[y * cropWidth + x] = currentMask[sourceY * width + sourceX];
    }
  }

  const cropInputs = await processor(await RawImage.fromCanvas(crop));
  const cropEmbeddings = await model.get_image_embeddings(cropInputs);
  const { masks } = await decode(cropInputs, cropEmbeddings, [...cropPoints, ...boxPrompt(cropBox)], cropWidth, cropHeight);

  let refined = preview;
  let bestIoU = MIN_REFINE_IOU;
  for (const mask of masks) {
    const iou = maskIoU(mask, preview);
    if (iou >= bestIoU) {
      bestIoU = iou;
      refined = mask;
    }
  }

  const constrained = constrainToPreview(refined, preview, cropWidth, cropHeight);
  const cleaned = cleanMask(constrained, cropWidth, cropHeight, cropPoints);
  const snapped = snapMaskToEdges(cropPixels, cleaned, cropWidth, cropHeight);
  const stroke = estimateStrokeRadius(cropPixels, snapped, cropWidth, cropHeight);
  const trimmed = removeSpurs(snapped, cropWidth, cropHeight, stroke);
  const final = cleanMask(trimmed, cropWidth, cropHeight, cropPoints);
  const alpha = featherMask(final, cropWidth, cropHeight);
  // 底图去掉的背景，图层里也不能留，否则白底图的图层会带着一块白板。
  const foreground = document.createElement('canvas');
  foreground.width = cropWidth;
  foreground.height = cropHeight;
  const foregroundContext = foreground.getContext('2d', { willReadFrequently: true });
  const toBackground = backgroundless.width / fullWidth;
  foregroundContext.drawImage(
    backgroundless,
    cropLeft * toBackground,
    cropTop * toBackground,
    (cropRight - cropLeft) * toBackground,
    (cropBottom - cropTop) * toBackground,
    0,
    0,
    cropWidth,
    cropHeight,
  );
  const foregroundPixels = foregroundContext.getImageData(0, 0, cropWidth, cropHeight).data;
  for (let i = 0; i < alpha.length; i += 1) alpha[i] = Math.min(alpha[i], foregroundPixels[i * 4 + 3]);
  const colors = cleanEdgeColors(cropPixels, alpha, cropWidth, cropHeight);
  const cutout = { width: cropWidth, height: cropHeight, colors, alpha, shrink, cropLeft, cropTop, action: '', follows: null };
  return renderCutout(cutout) ? cutout : null;
}

function composeCutout({ width: cutWidth, height: cutHeight, colors, alpha }) {
  const composed = new Uint8ClampedArray(colors);
  for (let i = 0; i < cutWidth * cutHeight; i += 1) {
    composed[i * 4 + 3] = Math.round((colors[i * 4 + 3] * alpha[i]) / 255);
  }
  return composed;
}

// 根据当前 alpha 生成裁好边的 PNG，全部擦光时返回 false。
function renderCutout(cutout) {
  const composed = composeCutout(cutout);
  const box = contentBounds(composed, cutout.width, cutout.height);
  if (!box) return false;
  const whole = document.createElement('canvas');
  whole.width = cutout.width;
  whole.height = cutout.height;
  whole.getContext('2d').putImageData(new ImageData(composed, cutout.width, cutout.height), 0, 0);
  const output = document.createElement('canvas');
  output.width = box.width;
  output.height = box.height;
  output.getContext('2d').drawImage(whole, -box.x, -box.y);
  cutout.png = output.toDataURL('image/png');
  // 图层在原图里的位置，保存时用来放回原位。
  cutout.rect = {
    x: cutout.cropLeft + box.x / cutout.shrink,
    y: cutout.cropTop + box.y / cutout.shrink,
    width: box.width / cutout.shrink,
    height: box.height / cutout.shrink,
  };
  return true;
}

function drawTouchup() {
  const { cutout, cursor } = touch;
  context.clearRect(0, 0, cutout.width, cutout.height);
  if (brushMode() === 'restore') {
    const ghost = new Uint8ClampedArray(cutout.colors);
    for (let i = 0; i < cutout.width * cutout.height; i += 1) ghost[i * 4 + 3] = Math.round(ghost[i * 4 + 3] * 0.3);
    touch.layer.getContext('2d').putImageData(new ImageData(ghost, cutout.width, cutout.height), 0, 0);
    context.drawImage(touch.layer, 0, 0);
  }
  touch.layer.getContext('2d').putImageData(new ImageData(composeCutout(cutout), cutout.width, cutout.height), 0, 0);
  context.drawImage(touch.layer, 0, 0);
  if (cursor) {
    context.beginPath();
    context.arc(cursor.x, cursor.y, brushRadius(), 0, Math.PI * 2);
    context.lineWidth = Math.max(1, cutout.width / 400);
    context.strokeStyle = '#111';
    context.stroke();
    context.beginPath();
    context.arc(cursor.x, cursor.y, brushRadius() + context.lineWidth, 0, Math.PI * 2);
    context.strokeStyle = '#fff';
    context.stroke();
  }
}

const brushMode = () => document.querySelector('input[name="brush-mode"]:checked').value;
const brushRadius = () => Number(brushSizeInput.value);

function setCanvasSize(canvasWidth, canvasHeight) {
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
}

function enterTouchup(cutout) {
  const layer = document.createElement('canvas');
  layer.width = cutout.width;
  layer.height = cutout.height;
  touch = { cutout, layer, strokes: [], painting: false, last: null, cursor: null };
  setCanvasSize(cutout.width, cutout.height);
  // 小对象放大到铺满工作区，边缘才修得准。
  const stage = canvas.parentElement;
  const zoom = Math.min((stage.clientWidth - 32) / cutout.width, (stage.clientHeight - 32) / cutout.height);
  canvas.style.width = `${Math.round(cutout.width * zoom)}px`;
  canvas.style.height = `${Math.round(cutout.height * zoom)}px`;
  titleEl.textContent = '修补边缘';
  pickTools.hidden = true;
  touchTools.hidden = false;
  cutoutsEl.inert = true;
  touchUndoButton.disabled = true;
  drawTouchup();
  updateButtons();
}

function exitTouchup() {
  // 全部擦光没有意义，这种情况退回进入修补前的样子。
  if (!renderCutout(touch.cutout) && touch.strokes.length) {
    touch.cutout.alpha = touch.strokes[0];
    renderCutout(touch.cutout);
  }
  touch = null;
  setCanvasSize(width, height);
  canvas.style.width = '';
  canvas.style.height = '';
  titleEl.textContent = '选择会动的部分';
  pickTools.hidden = false;
  touchTools.hidden = true;
  cutoutsEl.inert = false;
  renderCutouts();
  drawStage();
  updateButtons();
}

function canvasPoint(event, canvasWidth, canvasHeight) {
  const box = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - box.left) / box.width) * canvasWidth,
    y: ((event.clientY - box.top) / box.height) * canvasHeight,
  };
}

// 在两点之间连续盖章，快速拖动也不会断开。
function paintStroke(from, to) {
  const { cutout } = touch;
  const radius = brushRadius();
  const erase = brushMode() === 'erase';
  const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / Math.max(1, radius / 2)));
  for (let step = 0; step <= steps; step += 1) {
    const cx = from.x + ((to.x - from.x) * step) / steps;
    const cy = from.y + ((to.y - from.y) * step) / steps;
    const minY = Math.max(0, Math.floor(cy - radius - 1));
    const maxY = Math.min(cutout.height - 1, Math.ceil(cy + radius + 1));
    const minX = Math.max(0, Math.floor(cx - radius - 1));
    const maxX = Math.min(cutout.width - 1, Math.ceil(cx + radius + 1));
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        // 笔刷边缘留一像素过渡，修过的地方不会有锯齿。
        const coverage = Math.max(0, Math.min(1, radius + 0.5 - Math.hypot(x - cx, y - cy)));
        if (!coverage) continue;
        const i = y * cutout.width + x;
        cutout.alpha[i] = erase
          ? Math.min(cutout.alpha[i], Math.round(255 * (1 - coverage)))
          : Math.max(cutout.alpha[i], Math.round(255 * coverage));
      }
    }
  }
}

function renderCutouts() {
  cutoutsEl.replaceChildren(
    ...cutouts.map((cutout, index) => {
      const item = document.createElement('li');
      const thumb = document.createElement('img');
      thumb.src = cutout.png;
      thumb.alt = cutout.label ?? `对象 ${index + 1}`;
      thumb.title = cutout.label ?? '';
      const select = document.createElement('select');
      select.setAttribute('aria-label', `对象 ${index + 1} 的动作`);
      for (const [value, label] of ACTIONS) select.add(new Option(label, value));
      select.value = cutout.action;
      select.addEventListener('change', () => {
        cutout.action = select.value;
      });
      const follow = document.createElement('select');
      follow.className = 'follow';
      follow.setAttribute('aria-label', `对象 ${index + 1} 跟随谁`);
      follow.add(new Option('不跟随', ''));
      cutouts.forEach((other, otherIndex) => {
        if (other !== cutout) follow.add(new Option(`跟随第 ${otherIndex + 1} 个`, String(otherIndex)));
      });
      follow.value = cutout.follows ? String(cutouts.indexOf(cutout.follows)) : '';
      follow.addEventListener('change', () => {
        cutout.follows = follow.value === '' ? null : cutouts[Number(follow.value)];
      });
      const selects = document.createElement('div');
      selects.className = 'selects';
      selects.append(select, follow);
      const repair = document.createElement('button');
      repair.type = 'button';
      repair.textContent = '修';
      repair.className = 'repair';
      repair.setAttribute('aria-label', `修补对象 ${index + 1}`);
      repair.addEventListener('click', () => enterTouchup(cutout));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.className = 'remove';
      remove.setAttribute('aria-label', `删除对象 ${index + 1}`);
      remove.addEventListener('click', () => {
        cutouts.splice(index, 1);
        for (const other of cutouts) {
          if (other.follows === cutout) other.follows = null;
        }
        renderCutouts();
        updateButtons();
      });
      item.append(thumb, selects, repair, remove);
      return item;
    }),
  );
}

function showError(error) {
  console.error(error);
  setStatus(`出错了：${error.message ?? error}`);
}

canvas.addEventListener('click', (event) => {
  if (!touch) addPoint(event, 1);
});
canvas.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  if (!touch) addPoint(event, 0);
});
canvas.addEventListener('pointerdown', (event) => {
  if (!touch || event.button !== 0) return;
  canvas.setPointerCapture(event.pointerId);
  touch.strokes.push(new Uint8ClampedArray(touch.cutout.alpha));
  if (touch.strokes.length > MAX_UNDO) touch.strokes.splice(1, 1);
  touch.painting = true;
  touch.last = canvasPoint(event, touch.cutout.width, touch.cutout.height);
  paintStroke(touch.last, touch.last);
  touch.cursor = touch.last;
  touchUndoButton.disabled = false;
  drawTouchup();
});
canvas.addEventListener('pointermove', (event) => {
  if (!touch) return;
  const point = canvasPoint(event, touch.cutout.width, touch.cutout.height);
  if (touch.painting) {
    paintStroke(touch.last, point);
    touch.last = point;
  }
  touch.cursor = point;
  drawTouchup();
});
const endStroke = () => {
  if (touch) touch.painting = false;
};
canvas.addEventListener('pointerup', endStroke);
canvas.addEventListener('pointercancel', endStroke);
canvas.addEventListener('pointerleave', () => {
  if (!touch || touch.painting) return;
  touch.cursor = null;
  drawTouchup();
});
touchUndoButton.addEventListener('click', () => {
  touch.cutout.alpha = touch.strokes.pop();
  touchUndoButton.disabled = !touch.strokes.length;
  drawTouchup();
});
touchDoneButton.addEventListener('click', exitTouchup);
for (const radio of document.querySelectorAll('input[name="brush-mode"]')) {
  radio.addEventListener('change', drawTouchup);
}
undoButton.addEventListener('click', () => {
  points.pop();
  segment().catch(showError);
});
clearButton.addEventListener('click', clearSelection);
nextRangeButton.addEventListener('click', () => {
  rank += 1;
  selectCandidate();
});
addButton.addEventListener('click', async () => {
  addButton.disabled = true;
  setStatus('正在精修边缘，几秒就好…');
  await letStatusPaint();
  try {
    const cutout = await cutOut();
    setStatus('');
    if (!cutout) {
      updateButtons();
      return;
    }
    cutouts.push(cutout);
    renderCutouts();
    clearSelection();
  } catch (error) {
    showError(error);
    updateButtons();
  }
});
// 被跟随的画在下面。同时避免互相跟随造成的死循环。
function orderLayers() {
  const ordered = [];
  const visit = (cutout, path) => {
    if (ordered.includes(cutout)) return;
    if (path.includes(cutout)) {
      cutout.follows = null;
      return;
    }
    if (cutout.follows) visit(cutout.follows, [...path, cutout]);
    if (!ordered.includes(cutout)) ordered.push(cutout);
  };
  for (const cutout of cutouts) visit(cutout, []);
  return ordered;
}

// 上面的图层盖住的地方，也要在下面的图层里补上。否则闭眼时，
// 女孩这一层还露着原来的眼睛。
async function fillCoveredLayers(ordered) {
  const results = [];
  const images = await Promise.all(
    ordered.map(async ({ png }) => {
      const image = new Image();
      image.src = png;
      await image.decode();
      return image;
    }),
  );
  ordered.forEach((cutout, index) => {
    const image = images[index];
    const layerCanvas = document.createElement('canvas');
    layerCanvas.width = image.naturalWidth;
    layerCanvas.height = image.naturalHeight;
    const layerContext = layerCanvas.getContext('2d', { willReadFrequently: true });
    layerContext.drawImage(image, 0, 0);
    const toLocal = image.naturalWidth / cutout.rect.width;

    const holeCanvas = document.createElement('canvas');
    holeCanvas.width = image.naturalWidth;
    holeCanvas.height = image.naturalHeight;
    const holeContext = holeCanvas.getContext('2d', { willReadFrequently: true });
    let covered = false;
    for (let upper = index + 1; upper < ordered.length; upper += 1) {
      const { rect } = ordered[upper];
      const overlaps =
        rect.x < cutout.rect.x + cutout.rect.width &&
        rect.x + rect.width > cutout.rect.x &&
        rect.y < cutout.rect.y + cutout.rect.height &&
        rect.y + rect.height > cutout.rect.y;
      if (!overlaps) continue;
      covered = true;
      // 闭眼时眼睛的位置完全露出来，模糊的图黑边晕得很宽，补底范围要放大一圈才不会混进黑色。
      const isEye = ordered[upper].action === 'blink' || ordered[upper].action === 'wink';
      const grow = isEye ? EYE_HOLE_GROW : 1;
      const drawWidth = rect.width * grow;
      const drawHeight = rect.height * grow;
      holeContext.drawImage(
        images[upper],
        (rect.x - (drawWidth - rect.width) / 2 - cutout.rect.x) * toLocal,
        (rect.y - (drawHeight - rect.height) / 2 - cutout.rect.y) * toLocal,
        drawWidth * toLocal,
        drawHeight * toLocal,
      );
    }
    if (!covered) {
      results.push(cutout.png);
      return;
    }
    const { width: localWidth, height: localHeight } = layerCanvas;
    const { data } = layerContext.getImageData(0, 0, localWidth, localHeight);
    const holeData = holeContext.getImageData(0, 0, localWidth, localHeight).data;
    const hole = new Uint8Array(localWidth * localHeight);
    for (let i = 0; i < hole.length; i += 1) hole[i] = holeData[i * 4 + 3] > 40 ? 1 : 0;
    const filled = fillHoles(data, hole, localWidth, localHeight);
    // 只补图层本来有内容的地方，不让它长到外面去。
    for (let i = 0; i < hole.length; i += 1) {
      if (data[i * 4 + 3] === 0) filled[i * 4 + 3] = 0;
    }
    layerContext.putImageData(new ImageData(filled, localWidth, localHeight), 0, 0);
    results.push(layerCanvas.toDataURL('image/png'));
  });
  return results;
}

// 底图是去掉背景的整张图，再把图层的位置用周围颜色补上，图层动起来才不会露出重影。
async function buildBase() {
  const scale = Math.min(1, MAX_BASE_SIDE / Math.max(fullWidth, fullHeight));
  const baseWidth = Math.round(fullWidth * scale);
  const baseHeight = Math.round(fullHeight * scale);
  const baseCanvas = document.createElement('canvas');
  baseCanvas.width = baseWidth;
  baseCanvas.height = baseHeight;
  const baseContext = baseCanvas.getContext('2d', { willReadFrequently: true });
  // 只留选中的部分时，底图是空的，桌面上就没有背景和装饰。
  if (!keepRestInput.checked) return { png: baseCanvas.toDataURL('image/png'), scale };
  baseContext.drawImage(full, 0, 0, baseWidth, baseHeight);
  const { data } = baseContext.getImageData(0, 0, baseWidth, baseHeight);
  removeBackground(data, baseWidth, baseHeight);

  const holeCanvas = document.createElement('canvas');
  holeCanvas.width = baseWidth;
  holeCanvas.height = baseHeight;
  const holeContext = holeCanvas.getContext('2d', { willReadFrequently: true });
  for (const cutout of cutouts) {
    const image = new Image();
    image.src = cutout.png;
    await image.decode();
    const { x, y, width: rectWidth, height: rectHeight } = cutout.rect;
    holeContext.drawImage(image, x * scale, y * scale, rectWidth * scale, rectHeight * scale);
  }
  const holeData = holeContext.getImageData(0, 0, baseWidth, baseHeight).data;
  const hole = new Uint8Array(baseWidth * baseHeight);
  for (let i = 0; i < hole.length; i += 1) hole[i] = holeData[i * 4 + 3] > 40 ? 1 : 0;

  // 只补图本来有内容的地方，已去掉的背景不能又长回来。
  const filled = fillHoles(data, hole, baseWidth, baseHeight);
  for (let i = 0; i < hole.length; i += 1) {
    if (data[i * 4 + 3] === 0) filled[i * 4 + 3] = 0;
  }
  baseContext.clearRect(0, 0, baseWidth, baseHeight);
  baseContext.putImageData(new ImageData(filled, baseWidth, baseHeight), 0, 0);
  return { png: baseCanvas.toDataURL('image/png'), scale };
}

saveButton.addEventListener('click', async () => {
  saveButton.disabled = true;
  setStatus('正在生成桌宠…');
  await letStatusPaint();
  const { png, scale } = await buildBase();
  const ordered = orderLayers();
  const layerPngs = await fillCoveredLayers(ordered);
  await window.editor.save({
    name: nameInput.value.trim(),
    base: png,
    layers: ordered.map(({ rect, action, follows }, index) => ({
      png: layerPngs[index],
      action: action || null,
      parent: follows ? ordered.indexOf(follows) : null,
      x: rect.x * scale,
      y: rect.y * scale,
      width: rect.width * scale,
      height: rect.height * scale,
    })),
  });
});

async function start() {
  const { dataUrl, name, visionConfigured: configured } = await window.editor.getImage();
  nameInput.value = name;
  visionConfigured = configured;
  setAutoHint();

  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  const shrink = Math.min(1, MAX_SIDE / Math.max(image.naturalWidth, image.naturalHeight));
  width = Math.round(image.naturalWidth * shrink);
  height = Math.round(image.naturalHeight * shrink);
  canvas.width = width;
  canvas.height = height;
  source.width = width;
  source.height = height;
  source.getContext('2d').drawImage(image, 0, 0, width, height);
  // 精修时要用原图的细节，预览和第一次分割才用缩小的版本。
  const fullShrink = Math.min(1, MAX_FULL_SIDE / Math.max(image.naturalWidth, image.naturalHeight));
  fullWidth = Math.round(image.naturalWidth * fullShrink);
  fullHeight = Math.round(image.naturalHeight * fullShrink);
  full.width = fullWidth;
  full.height = fullHeight;
  full.getContext('2d').drawImage(image, 0, 0, fullWidth, fullHeight);
  backgroundless.width = width;
  backgroundless.height = height;
  const backgroundlessContext = backgroundless.getContext('2d', { willReadFrequently: true });
  backgroundlessContext.drawImage(image, 0, 0, width, height);
  const withoutBackground = backgroundlessContext.getImageData(0, 0, width, height);
  removeBackground(withoutBackground.data, width, height);
  backgroundlessContext.putImageData(withoutBackground, 0, 0);
  drawStage();

  setStatus('正在加载分割模型…');
  await loadModel();
  setStatus('正在分析图片，几秒就好…');
  await letStatusPaint();
  const raw = await RawImage.fromCanvas(source);
  inputs = await processor(raw);
  embeddings = await model.get_image_embeddings(inputs);
  ready = true;
  setStatus('');
  updateButtons();
}

// 模型给的框只用来防止抠得太离谱，所以留点余量。
function clipToBox(mask, box) {
  if (!box) return mask;
  const marginX = (box.right - box.left) * BOX_MARGIN;
  const marginY = (box.bottom - box.top) * BOX_MARGIN;
  const minX = (box.left - marginX) * width;
  const maxX = (box.right + marginX) * width;
  const minY = (box.top - marginY) * height;
  const maxY = (box.bottom + marginY) * height;
  const clipped = new Uint8Array(mask);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (x < minX || x > maxX || y < minY || y > maxY) clipped[y * width + x] = 0;
    }
  }
  return clipped;
}

// 眼睛、手这些小部件长在身体上，它们的位置也算身体，否则身体可能只选到头发、丢了脸。
// 猫坐在纸箱上这种大对象是另一个东西，不算。
function smallChildPoints(objects, index) {
  const parentBox = objects[index].box;
  if (!parentBox) return [];
  const area = ({ left, right, top, bottom }) => (right - left) * (bottom - top);
  return objects
    .filter((child) => child.follows === index && child.box && area(child.box) < area(parentBox) * SMALL_CHILD_RATIO)
    .map((child) => child.points[0]);
}

// 手这种小部件和周围颜色接近，在框外四周各放一个“不要”的点，告诉模型范围到此为止。
function pointsAroundBox({ left, right, top, bottom }) {
  const centerX = (left + right) / 2;
  const centerY = (top + bottom) / 2;
  const gapX = (right - left) * AROUND_BOX_GAP;
  const gapY = (bottom - top) * AROUND_BOX_GAP;
  return [
    { x: centerX, y: Math.max(0, top - gapY) },
    { x: centerX, y: Math.min(1, bottom + gapY) },
    { x: Math.max(0, left - gapX), y: centerY },
    { x: Math.min(1, right + gapX), y: centerY },
  ];
}

function toPoint({ x, y }, label) {
  return { x: Math.round(x * (width - 1)), y: Math.round(y * (height - 1)), label };
}

async function runRecognition() {
  recognizing = true;
  updateButtons();
  try {
    setStatus('正在把图片发给模型识别，通常要半分钟…');
    const { recipe, error } = await window.editor.recognize(source.toDataURL('image/jpeg', 0.9));
    if (error) throw new Error(error);
    autoHint.textContent = recipe.theme ? `画面主题：${recipe.theme}` : '';
    // 自动识别列出的就是主体，其余的不放到桌面上。
    keepRestInput.checked = false;

    const made = new Map();
    let failed = 0;
    for (const [index, object] of recipe.objects.entries()) {
      if (cutouts.length >= MAX_OBJECTS) break;
      setStatus(`正在抠第 ${index + 1}/${recipe.objects.length} 个：${object.name}`);
      await letStatusPaint();
      const boxArea = object.box ? (object.box.right - object.box.left) * (object.box.bottom - object.box.top) : 0;
      const isLarge = boxArea >= LARGE_OBJECT_AREA;
      const isTiny = object.box && boxArea < TINY_OBJECT_AREA;
      points = [
        ...object.points.map((point) => toPoint(point, 1)),
        ...smallChildPoints(recipe.objects, index).map((point) => toPoint(point, 1)),
        ...object.exclude.map((point) => toPoint(point, 0)),
        ...(isTiny ? pointsAroundBox(object.box).map((point) => toPoint(point, 0)) : []),
      ];
      // 框提示只给大对象：小框会被模型整个填满，比如把眼睛抠成一个方块。
      hintBox = isLarge ? object.box : null;
      const pixelBox = object.box && {
        left: object.box.left * (width - 1),
        right: object.box.right * (width - 1),
        top: object.box.top * (height - 1),
        bottom: object.box.bottom * (height - 1),
      };
      const { masks, scores } = await decode(
        inputs,
        embeddings,
        [...points, ...boxPrompt(isLarge ? pixelBox : null)],
        width,
        height,
      );
      const order = rankMasks(masks, width, scores, points, pixelBox);
      // 依次试候选，跳过空的和填满矩形的（选错范围或被框截断）。
      currentMask = null;
      const isEye = object.action === 'blink' || object.action === 'wink';
      const pixels = source.getContext('2d').getImageData(0, 0, width, height).data;
      // 眼睛可能选到整个镜片，从小到大试，选到第一个没被框住的。
      const tryOrder = isEye
        ? [...order].sort((a, b) => masks[a].reduce((sum, v) => sum + (v > 0), 0) - masks[b].reduce((sum, v) => sum + (v > 0), 0))
        : order;
      const usable = [];
      for (const candidate of tryOrder) {
        const clipped = clipToBox(masks[candidate], object.box);
        const cleaned = cleanMask(clipped, width, height, points);
        if (cleaned.some((value) => value) && !looksLikeBlock(cleaned, width)) usable.push(cleaned);
      }
      if (isEye) {
        // 从大到小取第一个没被框住的：普通眼睛保留完整，戴眼镜的只取瞳孔。
        currentMask = [...usable].reverse().find((mask) => !isInsideDarkFrame(mask, pixels, width, height)) ?? usable[0] ?? null;
      } else {
        currentMask = usable[0] ?? null;
      }
      const cutout = currentMask ? await cutOut() : null;
      if (!cutout) {
        failed += 1;
        continue;
      }
      cutout.action = object.action ?? '';
      cutout.label = object.pose ? `${object.name}：${object.pose}` : object.name;
      cutout.follows = object.follows === null ? null : made.get(object.follows) ?? null;
      made.set(index, cutout);
      cutouts.push(cutout);
      renderCutouts();
      updateButtons();
    }
    points = [];
    hintBox = null;
    candidates = [];
    candidateOrder = [];
    currentMask = null;
    drawStage();
    setStatus(failed ? `有 ${failed} 个对象没抠出来，可以手动补。` : '');
  } catch (error) {
    showError(error);
  } finally {
    recognizing = false;
    updateButtons();
  }
}

autoButton.addEventListener('click', runRecognition);
document.getElementById('save-key').addEventListener('click', async () => {
  const apiKey = document.getElementById('api-key');
  const workspaceId = document.getElementById('workspace-id');
  if (!apiKey.value.trim()) {
    setStatus('请先填写 API Key');
    return;
  }
  visionConfigured = await window.editor.saveVision({ apiKey: apiKey.value, workspaceId: workspaceId.value });
  apiKey.value = '';
  workspaceId.value = '';
  document.getElementById('key-box').open = false;
  setAutoHint();
  setStatus('');
  updateButtons();
});
document.getElementById('whole').addEventListener('click', () => window.editor.importWhole());

start().catch(showError);
