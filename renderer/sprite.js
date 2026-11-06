// 从一张图里抠出角色并找出两条腿。都是纯函数，data 为 RGBA 像素数组。
const ALPHA_SOLID = 10;
const LEAK_GAP_RATIO = 0.008;

function alphaAt(data, width, x, y) {
  return data[(y * width + x) * 4 + 3];
}

function colorsClose(data, a, b, tolerance) {
  return (
    Math.abs(data[a] - data[b]) <= tolerance &&
    Math.abs(data[a + 1] - data[b + 1]) <= tolerance &&
    Math.abs(data[a + 2] - data[b + 2]) <= tolerance
  );
}

// 从边缘向内填充背景色，只处理透明或纯色背景，返回 transparent | removed | failed。
function removeBackground(data, width, height, tolerance = 22) {
  const total = width * height;
  let clear = 0;
  for (let i = 0; i < total; i += 1) {
    if (data[i * 4 + 3] < ALPHA_SOLID) clear += 1;
  }
  if (clear > total * 0.005) return 'transparent';

  const corners = [0, width - 1, (height - 1) * width, total - 1].map((i) => i * 4);
  const background = corners.find(
    (corner) => corners.filter((other) => colorsClose(data, corner, other, tolerance)).length >= 3,
  );
  if (background === undefined) return 'failed';

  const visited = new Uint8Array(total);
  const stack = [];
  const visit = (i) => {
    if (visited[i] || !colorsClose(data, i * 4, background, tolerance)) return;
    visited[i] = 1;
    stack.push(i);
  };
  for (let x = 0; x < width; x += 1) {
    visit(x);
    visit((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    visit(y * width);
    visit(y * width + width - 1);
  }
  while (stack.length) {
    const i = stack.pop();
    const x = i % width;
    if (x > 0) visit(i - 1);
    if (x < width - 1) visit(i + 1);
    if (i >= width) visit(i - width);
    if (i < total - width) visit(i + width);
  }
  const removed = withoutNarrowLeaks(visited, width, height);
  for (let i = 0; i < total; i += 1) {
    if (removed[i]) data[i * 4 + 3] = 0;
  }
  return 'removed';
}

// 描边是虚线时，背景色会从缝隙流进同色的身体（白猫的白毛）。真正的背景连成一大片，
// 所以只保留能从图片边缘经宽通道走到的部分，窄缝过不去。
function withoutNarrowLeaks(filled, width, height) {
  const total = width * height;
  const radius = Math.max(2, Math.round(Math.max(width, height) * LEAK_GAP_RATIO));

  // 每个填充像素到最近未填充像素的棋盘距离，图片外不算边界。
  const far = width + height;
  const distance = new Int32Array(total);
  for (let i = 0; i < total; i += 1) distance[i] = filled[i] ? far : 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if (!filled[i]) continue;
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
      if (!filled[i]) continue;
      if (x < width - 1) distance[i] = Math.min(distance[i], distance[i + 1] + 1);
      if (y < height - 1) {
        distance[i] = Math.min(distance[i], distance[i + width] + 1);
        if (x < width - 1) distance[i] = Math.min(distance[i], distance[i + width + 1] + 1);
        if (x > 0) distance[i] = Math.min(distance[i], distance[i + width - 1] + 1);
      }
    }
  }

  const neighbours = (i) => {
    const x = i % width;
    const list = [];
    if (x > 0) list.push(i - 1);
    if (x < width - 1) list.push(i + 1);
    if (i >= width) list.push(i - width);
    if (i < total - width) list.push(i + width);
    return list;
  };

  // 从边缘出发，只走离物体足够远的像素，也就是通道宽于缝隙的地方。
  const reached = new Uint8Array(total);
  const stack = [];
  const seed = (i) => {
    if (filled[i] && !reached[i]) {
      reached[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < width; x += 1) {
    seed(x);
    seed((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    seed(y * width);
    seed(y * width + width - 1);
  }
  const edgePixels = [...stack];
  while (stack.length) {
    for (const n of neighbours(stack.pop())) {
      if (filled[n] && !reached[n] && distance[n] > radius) {
        reached[n] = 1;
        stack.push(n);
      }
    }
  }
  // 图太小、留白太窄，走不进去时就是没有宽通道，不能据此判断，退回原来的结果。
  if (edgePixels.length === reached.reduce((sum, value) => sum + value, 0)) return filled;

  // 再向外补回贴着物体、宽度不到 radius 的那一圈背景。
  let frontier = [];
  for (let i = 0; i < total; i += 1) {
    if (reached[i]) frontier.push(i);
  }
  for (let step = 0; step < radius && frontier.length; step += 1) {
    const next = [];
    for (const i of frontier) {
      for (const n of neighbours(i)) {
        if (filled[n] && !reached[n]) {
          reached[n] = 1;
          next.push(n);
        }
      }
    }
    frontier = next;
  }
  return reached;
}

function contentBounds(data, width, height) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (alphaAt(data, width, x, y) < ALPHA_SOLID) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

// 只在 hipY 以下做连通填充，这样手臂和裤腿不会连成一块。
function fillLeg(data, width, height, seedX, seedY, hipY) {
  const mask = new Uint8Array(width * height);
  const stack = [seedY * width + seedX];
  mask[stack[0]] = 1;
  let area = 0;
  let minX = seedX;
  let maxX = seedX;
  let maxY = seedY;
  while (stack.length) {
    const i = stack.pop();
    const x = i % width;
    const y = (i - x) / width;
    area += 1;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    const neighbours = [];
    if (x > 0) neighbours.push(i - 1);
    if (x < width - 1) neighbours.push(i + 1);
    if (y > hipY) neighbours.push(i - width);
    if (y < height - 1) neighbours.push(i + width);
    for (const n of neighbours) {
      if (!mask[n] && data[n * 4 + 3] >= ALPHA_SOLID) {
        mask[n] = 1;
        stack.push(n);
      }
    }
  }
  return { mask, area, minX, maxX, maxY };
}

// 要求图已裁到内容边界。在身体中线附近找脚下的透明缝，缝顶就是胯部。
// mask 取值：1 只属于腿，2 是胯部重叠区，身体和腿都画，摆腿时不露缝。
function detectLegs(data, width, height) {
  let solid = 0;
  let sumX = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (alphaAt(data, width, x, y) >= ALPHA_SOLID) {
        solid += 1;
        sumX += x;
      }
    }
  }
  if (!solid) return null;
  const centerX = Math.round(sumX / solid);

  const radius = Math.round(width * 0.2);
  let gapX = -1;
  let gap = 0;
  for (let offset = 0; offset <= radius; offset += 1) {
    for (const x of [centerX - offset, centerX + offset]) {
      if (x < 0 || x >= width) continue;
      let run = 0;
      while (run < height && alphaAt(data, width, x, height - 1 - run) < ALPHA_SOLID) run += 1;
      if (run > gap) {
        gap = run;
        gapX = x;
      }
    }
  }
  if (gap < height * 0.06 || gap > height * 0.6) return null;

  const hipY = height - gap;
  const seedY = Math.min(hipY + 2, height - 1);
  let leftX = gapX;
  while (leftX >= 0 && alphaAt(data, width, leftX, seedY) < ALPHA_SOLID) leftX -= 1;
  let rightX = gapX;
  while (rightX < width && alphaAt(data, width, rightX, seedY) < ALPHA_SOLID) rightX += 1;
  if (leftX < 0 || rightX >= width) return null;

  const fills = [fillLeg(data, width, height, leftX, seedY, hipY), fillLeg(data, width, height, rightX, seedY, hipY)];
  if (fills[0].mask[seedY * width + rightX]) return null;

  const legs = [];
  const overlap = Math.max(2, Math.round(gap * 0.25));
  for (const fill of fills) {
    const reachesGround = fill.maxY >= height - 1 - gap * 0.3;
    const legSized = fill.area >= solid * 0.01 && fill.maxX - fill.minX + 1 <= width * 0.45;
    if (!reachesGround || !legSized) return null;

    let topMin = width;
    let topMax = -1;
    for (let x = 0; x < width; x += 1) {
      if (!fill.mask[seedY * width + x]) continue;
      if (x < topMin) topMin = x;
      if (x > topMax) topMax = x;
    }
    for (let y = Math.max(0, hipY - overlap); y < hipY; y += 1) {
      for (let x = topMin; x <= topMax; x += 1) {
        if (alphaAt(data, width, x, y) >= ALPHA_SOLID) fill.mask[y * width + x] = 2;
      }
    }
    legs.push({ mask: fill.mask, pivotX: (topMin + topMax) / 2 });
  }
  return { hipY, legs };
}

// 按连通区域把图拆成多个对象，从左到右排序，每个对象都裁到自己的边界。
// 太小的碎片（星星、掉落的配件）归给附近的对象，离得远就丢弃。
function findObjects(data, width, height, maxObjects = 6) {
  const labels = new Int32Array(width * height).fill(-1);
  const parts = [];
  let solid = 0;

  for (let start = 0; start < width * height; start += 1) {
    if (labels[start] !== -1 || data[start * 4 + 3] < ALPHA_SOLID) continue;
    const part = { id: parts.length, area: 0, minX: width, maxX: -1, minY: height, maxY: -1 };
    const stack = [start];
    labels[start] = part.id;
    while (stack.length) {
      const i = stack.pop();
      const x = i % width;
      const y = (i - x) / width;
      part.area += 1;
      if (x < part.minX) part.minX = x;
      if (x > part.maxX) part.maxX = x;
      if (y < part.minY) part.minY = y;
      if (y > part.maxY) part.maxY = y;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const n = ny * width + nx;
          if (labels[n] === -1 && data[n * 4 + 3] >= ALPHA_SOLID) {
            labels[n] = part.id;
            stack.push(n);
          }
        }
      }
    }
    solid += part.area;
    parts.push(part);
  }
  if (!parts.length) return [];

  const largest = Math.max(...parts.map((part) => part.area));
  const minArea = Math.max(largest * 0.08, solid * 0.01);
  const objects = parts
    .filter((part) => part.area >= minArea)
    .sort((a, b) => b.area - a.area)
    .slice(0, maxObjects)
    .map((part) => ({ ...part, ids: new Set([part.id]) }));

  const maxGap = Math.max(width, height) * 0.08;
  for (const part of parts) {
    if (objects.some((object) => object.ids.has(part.id)) || part.area >= minArea) continue;
    let owner = null;
    let ownerGap = maxGap;
    for (const object of objects) {
      const gapX = Math.max(object.minX - part.maxX, part.minX - object.maxX, 0);
      const gapY = Math.max(object.minY - part.maxY, part.minY - object.maxY, 0);
      const gap = Math.max(gapX, gapY);
      if (gap <= ownerGap) {
        owner = object;
        ownerGap = gap;
      }
    }
    if (!owner) continue;
    owner.ids.add(part.id);
    owner.area += part.area;
    owner.minX = Math.min(owner.minX, part.minX);
    owner.maxX = Math.max(owner.maxX, part.maxX);
    owner.minY = Math.min(owner.minY, part.minY);
    owner.maxY = Math.max(owner.maxY, part.maxY);
  }

  return objects
    .sort((a, b) => a.minX - b.minX)
    .map((object) => {
      const cropWidth = object.maxX - object.minX + 1;
      const cropHeight = object.maxY - object.minY + 1;
      const pixels = new Uint8ClampedArray(cropWidth * cropHeight * 4);
      for (let y = 0; y < cropHeight; y += 1) {
        for (let x = 0; x < cropWidth; x += 1) {
          const from = (y + object.minY) * width + x + object.minX;
          if (object.ids.has(labels[from])) {
            pixels.set(data.subarray(from * 4, from * 4 + 4), (y * cropWidth + x) * 4);
          }
        }
      }
      return { x: object.minX, y: object.minY, width: cropWidth, height: cropHeight, area: object.area, data: pixels };
    });
}

// 只看轮廓推荐动作，分不出鱼和鸟，这一步之后可以由用户或视觉模型覆盖。
function suggestAction(width, height, area, hasLegs) {
  if (hasLegs) return 'walk';
  const aspect = width / height;
  if (aspect >= 1.5) return 'slide';
  if (aspect <= 0.55) return 'sway';
  return area / (width * height) >= 0.6 ? 'hop' : 'sway';
}

if (typeof module !== 'undefined') {
  module.exports = { removeBackground, contentBounds, detectLegs, findObjects, suggestAction };
}
