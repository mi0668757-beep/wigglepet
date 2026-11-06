// 把分割模型的原始蒙版整理成可以抠图的结果。mask 为 w*h 的 0/1 数组，都是纯函数。

function maskContains(mask, width, point) {
  return mask[Math.round(point.y) * width + Math.round(point.x)] > 0;
}

// 模型一次给出几个范围不同的候选。只圈住一个小斑点的结果也可能得高分，
// 所以先看是否覆盖了点击位置，再把过小的排到后面，最后才比分数。
// 如果给了期望的边界框 box（像素坐标），和它最吻合的优先，比如“身体”不能只选到头发。
function rankMasks(masks, width, scores, points, box = null, minAreaRatio = 0.002) {
  const minArea = masks[0].length * minAreaRatio;
  const fit = (mask) =>
    points.reduce((sum, point) => sum + (maskContains(mask, width, point) === (point.label === 1) ? 1 : 0), 0);
  return masks
    .map((mask, index) => ({
      index,
      fit: fit(mask),
      score: scores[index],
      boxFit: box ? boxOverlap(maskBox(mask, width), box) : 0,
      area: mask.reduce((a, b) => a + (b > 0 ? 1 : 0), 0),
    }))
    .filter((candidate) => candidate.area > 0)
    .sort(
      (a, b) =>
        b.fit - a.fit || (b.area >= minArea) - (a.area >= minArea) || b.boxFit - a.boxFit || b.score - a.score,
    )
    .map((candidate) => candidate.index);
}

function maskBox(mask, width) {
  let left = width;
  let right = -1;
  let top = Infinity;
  let bottom = -1;
  for (let i = 0; i < mask.length; i += 1) {
    if (!mask[i]) continue;
    const x = i % width;
    const y = (i - x) / width;
    if (x < left) left = x;
    if (x > right) right = x;
    if (y < top) top = y;
    if (y > bottom) bottom = y;
  }
  return right < 0 ? null : { left, right: right + 1, top, bottom: bottom + 1 };
}

function boxOverlap(a, b) {
  if (!a || !b) return 0;
  const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  if (width <= 0 || height <= 0) return 0;
  const both = width * height;
  const area = (box) => (box.right - box.left) * (box.bottom - box.top);
  return both / (area(a) + area(b) - both);
}

function fillRegion(source, width, height, start, value, visited) {
  const stack = [start];
  const pixels = [];
  visited[start] = 1;
  while (stack.length) {
    const i = stack.pop();
    pixels.push(i);
    const x = i % width;
    const neighbours = [];
    if (x > 0) neighbours.push(i - 1);
    if (x < width - 1) neighbours.push(i + 1);
    if (i >= width) neighbours.push(i - width);
    if (i < width * (height - 1)) neighbours.push(i + width);
    for (const n of neighbours) {
      if (!visited[n] && (source[n] > 0) === value) {
        visited[n] = 1;
        stack.push(n);
      }
    }
  }
  return pixels;
}

// 只保留和点击位置连通的部分，并填上内部的小洞。
function cleanMask(mask, width, height, points, maxHoleRatio = 0.03) {
  const total = width * height;
  const result = new Uint8Array(total);
  const visited = new Uint8Array(total);
  const positives = points.filter((point) => point.label === 1);
  let largest = [];
  let kept = 0;

  for (const point of positives) {
    const start = Math.round(point.y) * width + Math.round(point.x);
    if (mask[start] > 0 && !visited[start]) {
      for (const i of fillRegion(mask, width, height, start, true, visited)) {
        result[i] = 1;
        kept += 1;
      }
    }
  }
  // 点击位置都不在蒙版里时，退回到最大的一块。
  if (!kept) {
    for (let i = 0; i < total; i += 1) {
      if (mask[i] > 0 && !visited[i]) {
        const region = fillRegion(mask, width, height, i, true, visited);
        if (region.length > largest.length) largest = region;
      }
    }
    for (const i of largest) result[i] = 1;
    kept = largest.length;
  }

  const holesVisited = new Uint8Array(total);
  for (let i = 0; i < total; i += 1) {
    if (result[i] || holesVisited[i]) continue;
    const region = fillRegion(result, width, height, i, false, holesVisited);
    const touchesEdge = region.some((p) => {
      const x = p % width;
      return x === 0 || x === width - 1 || p < width || p >= total - width;
    });
    if (!touchesEdge && region.length <= kept * maxHoleRatio) {
      for (const p of region) result[p] = 1;
    }
  }
  return result;
}

function boxBlur(values, width, height, radius) {
  const horizontal = new Float32Array(width * height);
  const output = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      let count = 0;
      for (let dx = -radius; dx <= radius; dx += 1) {
        const nx = x + dx;
        if (nx < 0 || nx >= width) continue;
        sum += values[y * width + nx];
        count += 1;
      }
      horizontal[y * width + x] = sum / count;
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      let count = 0;
      for (let dy = -radius; dy <= radius; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        sum += horizontal[ny * width + x];
        count += 1;
      }
      output[y * width + x] = sum / count;
    }
  }
  return output;
}

// 每个像素到最近的“值为 target”的像素的棋盘距离。
function distanceTo(mask, width, height, target) {
  const total = width * height;
  const far = width + height;
  const distance = new Int32Array(total);
  for (let i = 0; i < total; i += 1) distance[i] = (mask[i] > 0) === target ? 0 : far;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if (x > 0) distance[i] = Math.min(distance[i], distance[i - 1] + 1);
      if (y > 0) {
        distance[i] = Math.min(distance[i], distance[i - width] + 1);
        if (x > 0) distance[i] = Math.min(distance[i], distance[i - width - 1] + 1);
        if (x < width - 1) distance[i] = Math.min(distance[i], distance[i - width + 1] + 1);
      }
    }
  }
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const i = y * width + x;
      if (x < width - 1) distance[i] = Math.min(distance[i], distance[i + 1] + 1);
      if (y < height - 1) {
        distance[i] = Math.min(distance[i], distance[i + width] + 1);
        if (x < width - 1) distance[i] = Math.min(distance[i], distance[i + width + 1] + 1);
        if (x > 0) distance[i] = Math.min(distance[i], distance[i + width - 1] + 1);
      }
    }
  }
  return distance;
}

// 透明像素按白底合成，再取相邻像素的最大色差作为边缘强度（0-255）。
function edgeStrength(rgba, width, height) {
  const channels = new Float32Array(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    const alpha = rgba[i * 4 + 3] / 255;
    for (let c = 0; c < 3; c += 1) channels[i * 3 + c] = rgba[i * 4 + c] * alpha + 255 * (1 - alpha);
  }
  const strength = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const left = x > 0 ? i - 1 : i;
      const right = x < width - 1 ? i + 1 : i;
      const up = y > 0 ? i - width : i;
      const down = y < height - 1 ? i + width : i;
      let best = 0;
      for (let c = 0; c < 3; c += 1) {
        best = Math.max(
          best,
          Math.abs(channels[right * 3 + c] - channels[left * 3 + c]),
          Math.abs(channels[down * 3 + c] - channels[up * 3 + c]),
        );
      }
      strength[i] = Math.min(255, Math.round(best));
    }
  }
  return { strength, channels };
}

const OUTLINE_LUMINANCE = 110;
// 描边要明显比对象本身暗，但浅色对象的描边可能也不深（比如粉色手的浅紫色描边），
// 所以阈值按对象内部的亮度来定，并限制在合理范围内。
const OUTLINE_CONTRAST = 60;
const MAX_OUTLINE_LUMINANCE = 170;

function outlineThreshold(luminance, mask) {
  const inside = [];
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i] > 0) inside.push(luminance[i]);
  }
  if (!inside.length) return OUTLINE_LUMINANCE;
  inside.sort((a, b) => a - b);
  const median = inside[Math.floor(inside.length / 2)];
  return Math.max(OUTLINE_LUMINANCE, Math.min(MAX_OUTLINE_LUMINANCE, median - OUTLINE_CONTRAST));
}

// 让蒙版边界贴合原图：蒙版只负责大致位置，真正的边界由图里的颜色边缘决定。
// 1. 蒙版边界两侧一圈设为待定，更里面确定是前景，更外面确定是背景。
// 2. 待定区里连着对象的细深色线条视为描边，归前景；粗的深色块是别的对象，比如头发，不归。
// 3. 前景和背景从两侧同时向待定区生长，优先走颜色平坦的地方，在最强的边缘处相遇。
function snapMaskToEdges(rgba, mask, width, height, bandRatio = 0.02) {
  const total = width * height;
  const band = Math.max(3, Math.round(Math.max(width, height) * bandRatio));
  // 蒙版内部通常可靠，向内的待定区窄一些，否则手这类小部件内部没有前景，会被背景吞掉。
  const innerBand = Math.max(1, Math.round(band / 3));
  const toOutside = distanceTo(mask, width, height, false);
  const toInside = distanceTo(mask, width, height, true);
  const { strength, channels } = edgeStrength(rgba, width, height);
  const FOREGROUND = 1;
  const BACKGROUND = 2;
  const labels = new Uint8Array(total);
  for (let i = 0; i < total; i += 1) {
    if (mask[i] > 0 && toOutside[i] > innerBand) labels[i] = FOREGROUND;
    else if (mask[i] === 0 && toInside[i] > band) labels[i] = BACKGROUND;
  }

  const luminance = new Float32Array(total);
  for (let i = 0; i < total; i += 1) {
    luminance[i] = 0.299 * channels[i * 3] + 0.587 * channels[i * 3 + 1] + 0.114 * channels[i * 3 + 2];
  }
  const threshold = outlineThreshold(luminance, mask);
  const dark = new Uint8Array(total);
  for (let i = 0; i < total; i += 1) {
    if (luminance[i] < threshold) dark[i] = 1;
  }
  // 开运算留下粗的深色块，从深色里去掉它们就只剩细线。
  const fromLight = distanceTo(dark, width, height, false);
  const eroded = new Uint8Array(total);
  for (let i = 0; i < total; i += 1) eroded[i] = fromLight[i] > band ? 1 : 0;
  const toThick = distanceTo(eroded, width, height, true);
  const outline = new Uint8Array(total);
  for (let i = 0; i < total; i += 1) outline[i] = dark[i] && toThick[i] > band ? 1 : 0;

  const stack = [];
  const neighboursOf = (i) => {
    const x = i % width;
    const list = [];
    if (x > 0) list.push(i - 1);
    if (x < width - 1) list.push(i + 1);
    if (i >= width) list.push(i - width);
    if (i < total - width) list.push(i + width);
    return list;
  };
  // 模型的蒙版常常差几个像素才碰到描边，所以离蒙版不远的细线也算。
  const reach = Math.ceil(band * 0.75);
  for (let i = 0; i < total; i += 1) {
    if (!labels[i] && outline[i] && toInside[i] <= reach) {
      labels[i] = FOREGROUND;
      stack.push(i);
    }
  }
  // 描边可以比待定区更宽一些，这时也要覆盖已判为背景的外缘，但不能沿线跑太远。
  while (stack.length) {
    for (const n of neighboursOf(stack.pop())) {
      if (labels[n] !== FOREGROUND && outline[n] && toInside[n] <= band * 2) {
        labels[n] = FOREGROUND;
        stack.push(n);
      }
    }
  }

  // 按边缘强度分桶的优先队列，从平坦处开始生长。
  const buckets = Array.from({ length: 256 }, () => []);
  for (let i = 0; i < total; i += 1) {
    if (labels[i] && neighboursOf(i).some((n) => !labels[n])) buckets[0].push(i);
  }
  for (let level = 0; level < 256; level += 1) {
    const bucket = buckets[level];
    while (bucket.length) {
      const i = bucket.pop();
      for (const n of neighboursOf(i)) {
        if (labels[n]) continue;
        labels[n] = labels[i];
        buckets[Math.max(level, strength[n])].push(n);
      }
    }
  }

  const result = new Uint8Array(total);
  for (let i = 0; i < total; i += 1) result[i] = labels[i] === FOREGROUND ? 1 : 0;
  return result;
}

// 放大后重新分割能看清细节，但范围可能跑偏：多带上旁边的东西，或漏掉本来对的部分。
// 用户是看着预览确认的，所以结果只能在预览边界附近变化。
function constrainToPreview(refined, preview, width, height, slackRatio = 0.03) {
  const slack = Math.max(2, Math.round(Math.max(width, height) * slackRatio));
  const toPreview = distanceTo(preview, width, height, true);
  const toPreviewOutside = distanceTo(preview, width, height, false);
  const result = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i += 1) {
    if (preview[i] > 0 && toPreviewOutside[i] > slack) result[i] = 1;
    else if (preview[i] === 0 && toPreview[i] > slack) result[i] = 0;
    else result[i] = refined[i] > 0 ? 1 : 0;
  }
  return result;
}

// 估算图里线条的半宽：只统计深色区域的中心脊线，大片深色（头发）的脊线很短，
// 不会影响结果。取 75 分位，线条粗细不均时偏向粗的一侧。
function estimateStrokeRadius(rgba, mask, width, height) {
  const total = width * height;
  const dark = new Uint8Array(total);
  for (let i = 0; i < total; i += 1) {
    if (!mask[i]) continue;
    const luminance = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
    if (luminance < OUTLINE_LUMINANCE) dark[i] = 1;
  }
  const fromLight = distanceTo(dark, width, height, false);
  const ridge = [];
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      const value = fromLight[i];
      if (!dark[i]) continue;
      if (value >= fromLight[i - 1] && value >= fromLight[i + 1] && value >= fromLight[i - width] && value >= fromLight[i + width]) {
        ridge.push(value);
      }
    }
  }
  if (!ridge.length) return 1;
  ridge.sort((a, b) => a - b);
  return ridge[Math.floor(ridge.length * 0.75)];
}

// 去掉伸出去的细线：比线条还细的部分不算身体，只保留贴着身体的那一圈描边。
function removeSpurs(mask, width, height, strokeRadius) {
  const total = width * height;
  const radius = strokeRadius + 1;
  const toOutside = distanceTo(mask, width, height, false);
  const core = new Uint8Array(total);
  for (let i = 0; i < total; i += 1) core[i] = toOutside[i] > radius ? 1 : 0;
  const toCore = distanceTo(core, width, height, true);
  const result = new Uint8Array(total);
  // 主体薄得没有核心时，说明对象本身就是线条状，保持不动。
  if (!core.some((value) => value)) return Uint8Array.from(mask);
  for (let i = 0; i < total; i += 1) result[i] = mask[i] > 0 && toCore[i] <= radius * 2 + 1 ? 1 : 0;
  return result;
}

// 边缘只做一个像素的抗锯齿，返回 0-255 的 alpha。
function featherMask(mask, width, height) {
  const feather = boxBlur(mask, width, height, 1);
  const alpha = new Uint8ClampedArray(width * height);
  for (let i = 0; i < width * height; i += 1) alpha[i] = Math.round(feather[i] * 255);
  return alpha;
}

// 半透明的边缘像素还混着背景色，用旁边不透明像素的颜色替换，去掉白边。
function cleanEdgeColors(rgba, alpha, width, height, radius = 2) {
  const output = new Uint8ClampedArray(rgba);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if (alpha[i] === 0 || alpha[i] === 255) continue;
      const sum = [0, 0, 0];
      let count = 0;
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const n = ny * width + nx;
          if (alpha[n] !== 255) continue;
          for (let c = 0; c < 3; c += 1) sum[c] += rgba[n * 4 + c];
          count += 1;
        }
      }
      if (!count) continue;
      for (let c = 0; c < 3; c += 1) output[i * 4 + c] = Math.round(sum[c] / count);
    }
  }
  return output;
}

const FILL_BLUR_RADIUS = 6;

// 图层抠走后要补底图，否则图层一动就露出原来的画面（重影）。
// 洞里每个像素取最近的洞外像素（包括透明的），卡通的大色块这样补就够自然。
function fillHoles(rgba, hole, width, height, grow = 2) {
  const total = width * height;
  const toHole = distanceTo(hole, width, height, true);
  const output = new Uint8ClampedArray(rgba);
  const source = new Int32Array(total).fill(-1);
  let frontier = [];
  // 洞外扩几个像素，把描边的抗锯齿残留也算进洞里。
  for (let i = 0; i < total; i += 1) {
    if (toHole[i] > grow) {
      source[i] = i;
      frontier.push(i);
    }
  }
  while (frontier.length) {
    const next = [];
    for (const i of frontier) {
      const x = i % width;
      const neighbours = [];
      if (x > 0) neighbours.push(i - 1);
      if (x < width - 1) neighbours.push(i + 1);
      if (i >= width) neighbours.push(i - width);
      if (i < total - width) neighbours.push(i + width);
      for (const n of neighbours) {
        if (source[n] !== -1) continue;
        source[n] = source[i];
        output.set(rgba.subarray(source[i] * 4, source[i] * 4 + 4), n * 4);
        next.push(n);
      }
    }
    frontier = next;
  }

  // 最近邻填出来是一条条的拉丝，模糊一下才自然。透明像素不参与，避免把颜色调淡。
  const premultiplied = [0, 1, 2].map((channel) => {
    const values = new Float32Array(total);
    for (let i = 0; i < total; i += 1) values[i] = output[i * 4 + channel] * (output[i * 4 + 3] / 255);
    return boxBlur(values, width, height, FILL_BLUR_RADIUS);
  });
  const weights = new Float32Array(total);
  for (let i = 0; i < total; i += 1) weights[i] = output[i * 4 + 3] / 255;
  const blurredWeights = boxBlur(weights, width, height, FILL_BLUR_RADIUS);
  for (let i = 0; i < total; i += 1) {
    if (toHole[i] > grow || output[i * 4 + 3] === 0 || blurredWeights[i] === 0) continue;
    for (let channel = 0; channel < 3; channel += 1) {
      output[i * 4 + channel] = Math.round(premultiplied[channel][i] / blurredWeights[i]);
    }
  }
  return output;
}

// 候选外面紧贴着一圈明显更深的颜色，而里面是浅色，说明它是被框住的区域，比如眼镜的镜片。
// 选眼睛时遇到这种情况，要换更小的候选，只选到瞳孔。
function isInsideDarkFrame(mask, rgba, width, height, gap = 6, contrast = 50) {
  const luminance = (i) => 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
  const toInside = distanceTo(mask, width, height, true);
  let inside = 0;
  let insideCount = 0;
  let ring = 0;
  let ringCount = 0;
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i] > 0) {
      inside += luminance(i);
      insideCount += 1;
    } else if (toInside[i] <= gap) {
      ring += luminance(i);
      ringCount += 1;
    }
  }
  if (!insideCount || !ringCount) return false;
  return inside / insideCount - ring / ringCount >= contrast;
}

// 结果几乎填满自己的边界矩形，多半是模型选错了范围，或被框截断了。
// 猫、人、眼睛这些轮廓都填不满矩形。
function looksLikeBlock(mask, width, threshold = 0.92) {
  const box = maskBox(mask, width);
  if (!box) return false;
  let area = 0;
  for (let i = 0; i < mask.length; i += 1) area += mask[i] > 0 ? 1 : 0;
  return area / ((box.right - box.left) * (box.bottom - box.top)) >= threshold;
}

function maskIoU(a, b) {
  let both = 0;
  let either = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] > 0 && b[i] > 0) both += 1;
    if (a[i] > 0 || b[i] > 0) either += 1;
  }
  return either ? both / either : 0;
}

if (typeof module !== 'undefined') {
  module.exports = {
    rankMasks,
    cleanMask,
    snapMaskToEdges,
    constrainToPreview,
    estimateStrokeRadius,
    removeSpurs,
    featherMask,
    cleanEdgeColors,
    fillHoles,
    looksLikeBlock,
    isInsideDarkFrame,
    maskIoU,
  };
}
