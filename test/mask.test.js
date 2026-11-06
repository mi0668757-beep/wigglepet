const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
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
} = require('../renderer/mask');

// 按函数给每个像素上色，生成 RGBA。
function paint(width, height, colorAt) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) rgba.set([...colorAt(x, y), 255], (y * width + x) * 4);
  }
  return rgba;
}

function maskFrom(width, height, test) {
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) mask[y * width + x] = test(x, y) ? 1 : 0;
  }
  return mask;
}

const WHITE = [255, 255, 255];
const ORANGE = [245, 170, 90];
const LINE = [70, 40, 20];
const BLACK = [20, 20, 20];

function grid(rows) {
  const width = rows[0].length;
  return { width, height: rows.length, mask: Uint8Array.from(rows.join('').split('').map((c) => (c === '#' ? 1 : 0))) };
}

const at = ({ mask, width }, x, y) => mask[y * width + x];

test('得高分的空结果排除在外', () => {
  const empty = grid(['....', '....']).mask;
  const filled = grid(['##..', '##..']).mask;
  const order = rankMasks([empty, filled], 4, [0.99, 0.6], [{ x: 0, y: 0, label: 1 }]);
  assert.deepEqual(order, [1]);
});

test('优先选择覆盖正向点、避开反向点的候选，而不是分数最高的', () => {
  const wrong = grid(['####', '####']).mask;
  const right = grid(['##..', '##..']).mask;
  const points = [
    { x: 0, y: 0, label: 1 },
    { x: 3, y: 1, label: 0 },
  ];
  assert.deepEqual(rankMasks([wrong, right], 4, [0.95, 0.7], points), [1, 0]);
});

test('覆盖情况相同时按分数排序', () => {
  const a = grid(['##..', '##..']).mask;
  const b = grid(['###.', '###.']).mask;
  assert.deepEqual(rankMasks([a, b], 4, [0.7, 0.9], [{ x: 0, y: 0, label: 1 }]), [1, 0]);
});

test('只圈住小斑点的候选即使分数最高也排到后面', () => {
  const size = 100;
  const speck = new Uint8Array(size * size);
  speck[50 * size + 50] = 1;
  const cat = new Uint8Array(size * size);
  for (let i = 40 * size; i < 60 * size; i += 1) cat[i] = 1;
  const order = rankMasks([speck, cat], size, [0.96, 0.7], [{ x: 50, y: 50, label: 1 }]);
  assert.deepEqual(order, [1, 0]);
});

test('给了期望的框时，选和框最吻合的候选，而不是分数最高的', () => {
  const size = 100;
  // 都覆盖点击位置：头发只占上半部分，整个身体才符合框。
  const hair = new Uint8Array(size * size);
  const wholeBody = new Uint8Array(size * size);
  for (let y = 20; y < 80; y += 1) {
    for (let x = 20; x < 80; x += 1) {
      wholeBody[y * size + x] = 1;
      if (y < 40) hair[y * size + x] = 1;
    }
  }
  const point = [{ x: 50, y: 30, label: 1 }];
  const box = { left: 20, right: 80, top: 20, bottom: 80 };
  assert.deepEqual(rankMasks([hair, wholeBody], size, [0.95, 0.6], point, box), [1, 0]);
  // 没有框时还是按分数。
  assert.deepEqual(rankMasks([hair, wholeBody], size, [0.95, 0.6], point), [0, 1]);
});

test('只保留和点击位置连通的部分，去掉碎渣', () => {
  const source = grid(['##...#', '##...#', '......', '.#....']);
  const cleaned = cleanMask(source.mask, source.width, source.height, [{ x: 0, y: 0, label: 1 }]);
  const result = { mask: cleaned, width: source.width };
  assert.equal(at(result, 1, 1), 1);
  assert.equal(at(result, 5, 0), 0);
  assert.equal(at(result, 1, 3), 0);
});

test('点到多个不相连部分时都保留', () => {
  const source = grid(['##..##', '##..##']);
  const cleaned = cleanMask(source.mask, source.width, source.height, [
    { x: 0, y: 0, label: 1 },
    { x: 5, y: 0, label: 1 },
  ]);
  assert.equal(cleaned.reduce((a, b) => a + b, 0), 8);
});

test('点击位置不在蒙版里时退回最大的一块', () => {
  const source = grid(['#.....', '...###', '...###']);
  const cleaned = cleanMask(source.mask, source.width, source.height, [{ x: 0, y: 2, label: 1 }]);
  const result = { mask: cleaned, width: source.width };
  assert.equal(at(result, 4, 1), 1);
  assert.equal(at(result, 0, 0), 0);
});

test('内部小洞被填上，大洞和连到边缘的缺口保留', () => {
  const rows = Array.from({ length: 30 }, () => '#'.repeat(30).split(''));
  rows[5][5] = '.';
  for (let y = 15; y < 25; y += 1) {
    for (let x = 10; x < 20; x += 1) rows[y][x] = '.';
  }
  rows[0][29] = '.';
  const source = grid(rows.map((row) => row.join('')));
  const cleaned = cleanMask(source.mask, source.width, source.height, [{ x: 1, y: 1, label: 1 }]);
  const result = { mask: cleaned, width: source.width };
  assert.equal(at(result, 5, 5), 1);
  assert.equal(at(result, 15, 20), 0);
  assert.equal(at(result, 29, 0), 0);
});

// 白底上一个带深色描边的橙色方块：方块占 [40,160)，描边 4 像素宽。
const SIZE = 200;
const square = paint(SIZE, SIZE, (x, y) => {
  const inOuter = x >= 40 && x < 160 && y >= 40 && y < 160;
  const inInner = x >= 44 && x < 156 && y >= 44 && y < 156;
  if (inInner) return ORANGE;
  return inOuter ? LINE : WHITE;
});
const trueSquare = maskFrom(SIZE, SIZE, (x, y) => x >= 40 && x < 160 && y >= 40 && y < 160);

test('粗糙的低分辨率蒙版被修正到对象的真实边界', () => {
  // 模拟放大裁切后 4 倍上采样的蒙版：有锯齿，边界比实际对象缩进了几个像素。
  const rough = maskFrom(SIZE, SIZE, (x, y) => {
    const blockX = Math.floor(x / 4) * 4;
    const blockY = Math.floor(y / 4) * 4;
    return blockX >= 44 && blockX < 156 && blockY >= 44 && blockY < 156;
  });
  assert.ok(maskIoU(rough, trueSquare) < 0.96, `IoU ${maskIoU(rough, trueSquare)}`);
  const snapped = snapMaskToEdges(square, rough, SIZE, SIZE);
  assert.ok(maskIoU(snapped, trueSquare) > 0.99, `IoU ${maskIoU(snapped, trueSquare)}`);
});

test('蒙版略微溢出到背景时收回到对象边界', () => {
  const over = maskFrom(SIZE, SIZE, (x, y) => x >= 38 && x < 162 && y >= 38 && y < 162);
  const snapped = snapMaskToEdges(square, over, SIZE, SIZE, 0.03);
  assert.ok(maskIoU(snapped, trueSquare) > 0.99, `IoU ${maskIoU(snapped, trueSquare)}`);
});

test('贴着边缘的小部件（手）内部不会被背景吞掉', () => {
  // 粉色地毯上一个 16 像素高的扁平手，手和地毯之间只有浅色描边。
  const RUG = [250, 225, 228];
  const HAND = [252, 215, 225];
  const THIN = [190, 130, 150];
  const picture = paint(SIZE, SIZE, (x, y) => {
    if (x >= 60 && x < 140 && y >= 40 && y < 100) return ORANGE;
    const inOuter = x >= 110 && x < 140 && y >= 100 && y < 116;
    const inInner = x >= 112 && x < 138 && y >= 100 && y < 114;
    if (inInner) return HAND;
    return inOuter ? THIN : RUG;
  });
  const truth = maskFrom(SIZE, SIZE, (x, y) => (x >= 60 && x < 140 && y >= 40 && y < 100) || (x >= 110 && x < 140 && y >= 100 && y < 116));
  const snapped = snapMaskToEdges(picture, truth, SIZE, SIZE, 0.06);
  assert.equal(snapped[106 * SIZE + 125], 1);
  assert.equal(snapped[130 * SIZE + 125], 0);
});

test('蒙版漏掉的细描边被补回来', () => {
  const inner = maskFrom(SIZE, SIZE, (x, y) => x >= 46 && x < 154 && y >= 46 && y < 154);
  const snapped = snapMaskToEdges(square, inner, SIZE, SIZE);
  const at2 = (x, y) => snapped[y * SIZE + x];
  assert.equal(at2(41, 100), 1);
  assert.equal(at2(100, 158), 1);
  assert.equal(at2(38, 100), 0);
});

test('浅色对象的浅色描边（粉手的浅紫边）也会被补回来', () => {
  const HAND = [252, 220, 228];
  const MAUVE = [170, 120, 140];
  const RUG = [250, 235, 238];
  const hand = paint(SIZE, SIZE, (x, y) => {
    const inOuter = x >= 40 && x < 160 && y >= 40 && y < 160;
    const inInner = x >= 44 && x < 156 && y >= 44 && y < 156;
    if (inInner) return HAND;
    return inOuter ? MAUVE : RUG;
  });
  const inner = maskFrom(SIZE, SIZE, (x, y) => x >= 46 && x < 154 && y >= 46 && y < 154);
  const snapped = snapMaskToEdges(hand, inner, SIZE, SIZE);
  assert.equal(snapped[100 * SIZE + 41], 1);
  assert.equal(snapped[100 * SIZE + 38], 0);
});

test('贴着对象的粗深色块（头发）不会被当成描边并入', () => {
  const withHair = paint(SIZE, SIZE, (x, y) => {
    if (x >= 160 && y >= 40 && y < 160) return BLACK;
    if (x >= 44 && x < 156 && y >= 44 && y < 156) return ORANGE;
    return x >= 40 && x < 160 && y >= 40 && y < 160 ? LINE : WHITE;
  });
  const snapped = snapMaskToEdges(withHair, trueSquare, SIZE, SIZE);
  assert.equal(snapped[100 * SIZE + 150], 1);
  assert.equal(snapped[100 * SIZE + 170], 0);
  const leaked = snapped.reduce((sum, value, i) => sum + (value && i % SIZE >= 165 ? 1 : 0), 0);
  assert.equal(leaked, 0);
});

test('修正不会越过明显的颜色边界跑到旁边的对象上', () => {
  const twoColors = paint(SIZE, SIZE, (x) => (x < 100 ? ORANGE : [80, 150, 240]));
  const left = maskFrom(SIZE, SIZE, (x) => x < 96);
  const snapped = snapMaskToEdges(twoColors, left, SIZE, SIZE);
  assert.equal(snapped[100 * SIZE + 98], 1);
  assert.equal(snapped[100 * SIZE + 103], 0);
});

test('重新分割多带上的大块被约束回预览附近', () => {
  const preview = maskFrom(SIZE, SIZE, (x, y) => x >= 60 && x < 120 && y >= 60 && y < 120);
  const withSleeve = maskFrom(SIZE, SIZE, (x, y) => x >= 58 && x < 190 && y >= 58 && y < 122);
  const result = constrainToPreview(withSleeve, preview, SIZE, SIZE);
  // 贴近预览的细节调整保留。
  assert.equal(result[59 * SIZE + 90], 1);
  // 远处多带上的部分去掉。
  assert.equal(result[90 * SIZE + 170], 0);
});

test('重新分割漏掉的大块按预览补回来', () => {
  const preview = maskFrom(SIZE, SIZE, (x, y) => x >= 40 && x < 160 && y >= 40 && y < 160);
  const missingHand = maskFrom(SIZE, SIZE, (x, y) => x >= 40 && x < 100 && y >= 40 && y < 160);
  const result = constrainToPreview(missingHand, preview, SIZE, SIZE);
  assert.equal(result[100 * SIZE + 130], 1);
  // 预览边缘附近仍以重新分割为准。
  assert.equal(result[100 * SIZE + 158], 0);
});

test('能从图里测出线条粗细', () => {
  // 描边 4 像素宽，半宽约 2。
  const radius = estimateStrokeRadius(square, trueSquare, SIZE, SIZE);
  assert.ok(radius >= 1 && radius <= 3, `半宽 ${radius}`);
});

test('大片深色（头发）不影响线条粗细的估算', () => {
  const withHair = paint(SIZE, SIZE, (x, y) => {
    if (x >= 60 && x < 140 && y >= 40 && y < 100) return BLACK;
    return square.subarray((y * SIZE + x) * 4, (y * SIZE + x) * 4 + 3);
  });
  const radius = estimateStrokeRadius(withHair, trueSquare, SIZE, SIZE);
  assert.ok(radius <= 3, `半宽 ${radius}`);
});

test('沿着旁边物体描边跑出去的细线被去掉，贴着身体的描边保留', () => {
  // 40x40 的身体，右边伸出一条 3 像素粗、50 像素长的线。
  const spur = maskFrom(SIZE, SIZE, (x, y) => (x >= 60 && x < 100 && y >= 60 && y < 100) || (x >= 100 && x < 150 && y >= 79 && y < 82));
  const trimmed = removeSpurs(spur, SIZE, SIZE, 2);
  assert.equal(trimmed[80 * SIZE + 140], 0);
  assert.equal(trimmed[60 * SIZE + 80], 1);
  assert.equal(trimmed[80 * SIZE + 60], 1);
});

test('比线条粗的部分（尾巴）不算细线，会保留', () => {
  const tail = maskFrom(SIZE, SIZE, (x, y) => (x >= 60 && x < 100 && y >= 60 && y < 100) || (x >= 100 && x < 150 && y >= 72 && y < 88));
  const trimmed = removeSpurs(tail, SIZE, SIZE, 2);
  assert.equal(trimmed[80 * SIZE + 140], 1);
});

test('整个对象都是细线时不做处理', () => {
  const thin = maskFrom(SIZE, SIZE, (x, y) => y >= 99 && y < 102 && x >= 20 && x < 180);
  assert.equal(maskIoU(removeSpurs(thin, SIZE, SIZE, 2), thin), 1);
});

test('边缘只留一像素的过渡，内外分明', () => {
  const alpha = featherMask(trueSquare, SIZE, SIZE);
  assert.equal(alpha[100 * SIZE + 100], 255);
  assert.equal(alpha[100 * SIZE + 37], 0);
  assert.ok(alpha[100 * SIZE + 40] > 0 && alpha[100 * SIZE + 40] < 255);
});

test('半透明边缘换成对象的颜色，去掉背景色', () => {
  const alpha = featherMask(trueSquare, SIZE, SIZE);
  // 描边外缘混了白色背景。
  const mixed = paint(SIZE, SIZE, (x, y) => {
    if (x === 39 || x === 40) return [190, 170, 160];
    return x >= 41 && x < 160 && y >= 40 && y < 160 ? LINE : WHITE;
  });
  const cleaned = cleanEdgeColors(mixed, alpha, SIZE, SIZE);
  const offset = (100 * SIZE + 40) * 4;
  assert.deepEqual([...cleaned.subarray(offset, offset + 3)], LINE);
  // 不透明的内部不变。
  const inside = (100 * SIZE + 100) * 4;
  assert.deepEqual([...cleaned.subarray(inside, inside + 3)], LINE);
});

test('底图的洞用周围颜色补上，不留下图层的重影', () => {
  // 橙色底上一个蓝色小猫，猫被抠走后蓝色不能留在底图里。
  const BLUE = [40, 90, 220];
  const picture = paint(100, 100, (x, y) => (x >= 40 && x < 60 && y >= 40 && y < 60 ? BLUE : ORANGE));
  const hole = maskFrom(100, 100, (x, y) => x >= 40 && x < 60 && y >= 40 && y < 60);
  const filled = fillHoles(picture, hole, 100, 100);
  for (let i = 0; i < 100 * 100; i += 1) {
    assert.deepEqual([...filled.subarray(i * 4, i * 4 + 3)], ORANGE);
  }
});

test('贴着透明背景的洞会补成透明，不会凭空长东西', () => {
  // 上半部分透明，下半部分橙色，洞横跨两边。
  const picture = new Uint8ClampedArray(100 * 100 * 4);
  for (let y = 50; y < 100; y += 1) {
    for (let x = 0; x < 100; x += 1) picture.set([...ORANGE, 255], (y * 100 + x) * 4);
  }
  const hole = maskFrom(100, 100, (x, y) => x >= 45 && x < 55 && y >= 30 && y < 70);
  const filled = fillHoles(picture, hole, 100, 100);
  assert.equal(filled[(35 * 100 + 50) * 4 + 3], 0);
  assert.equal(filled[(65 * 100 + 50) * 4 + 3], 255);
});

test('补出来的颜色是平滑过渡，不是一条条的拉丝', () => {
  // 洞的上下两边是条纹，最近邻会把条纹拉长穿过整个洞。
  const picture = paint(100, 100, (x, y) => (Math.floor(x / 4) % 2 ? [240, 160, 90] : [90, 60, 40]));
  const hole = maskFrom(100, 100, (x, y) => x >= 30 && x < 70 && y >= 30 && y < 70);
  const filled = fillHoles(picture, hole, 100, 100);
  let swing = 0;
  for (let x = 42; x < 58; x += 1) {
    swing = Math.max(swing, Math.abs(filled[(50 * 100 + x) * 4] - filled[(50 * 100 + x + 1) * 4]));
  }
  assert.ok(swing < 40, `相邻像素差 ${swing}`);
});

test('洞外的像素保持原样', () => {
  const picture = paint(50, 50, (x) => (x < 25 ? ORANGE : LINE));
  const hole = maskFrom(50, 50, (x, y) => x >= 5 && x < 10 && y >= 5 && y < 10);
  const filled = fillHoles(picture, hole, 50, 50);
  assert.deepEqual([...filled.subarray((40 * 50 + 40) * 4, (40 * 50 + 40) * 4 + 4)], [...LINE, 255]);
});

test('填满矩形的结果判定为抠错，椭圆和不规则轮廓不算', () => {
  const size = 100;
  const block = maskFrom(size, size, (x, y) => x >= 20 && x < 80 && y >= 30 && y < 70);
  const oval = maskFrom(size, size, (x, y) => ((x - 50) / 30) ** 2 + ((y - 50) / 20) ** 2 <= 1);
  const lShape = maskFrom(size, size, (x, y) => x >= 20 && x < 80 && y >= 20 && y < 80 && (x < 40 || y > 60));
  assert.equal(looksLikeBlock(block, size), true);
  assert.equal(looksLikeBlock(oval, size), false);
  assert.equal(looksLikeBlock(lShape, size), false);
  assert.equal(looksLikeBlock(new Uint8Array(size * size), size), false);
});

test('能认出被镜框围住的镜片，普通眼睛不算', () => {
  const size = 100;
  const circle = (r) => (x, y) => Math.hypot(x - 50, y - 50) <= r;
  const glasses = paint(size, size, (x, y) => {
    const d = Math.hypot(x - 50, y - 50);
    if (d <= 8) return [40, 40, 40];
    if (d <= 26) return [250, 245, 225];
    if (d <= 36) return [140, 90, 60];
    return [250, 240, 210];
  });
  assert.equal(isInsideDarkFrame(maskFrom(size, size, circle(26)), glasses, size, size), true);
  // 瞳孔外面是浅色，不是被框住。
  assert.equal(isInsideDarkFrame(maskFrom(size, size, circle(8)), glasses, size, size), false);
  // 灰猫的白眼睛，外面是灰色的脸，对比不够。
  const cat = paint(size, size, (x, y) => (Math.hypot(x - 50, y - 50) <= 20 ? [200, 200, 205] : [160, 160, 160]));
  assert.equal(isInsideDarkFrame(maskFrom(size, size, circle(20)), cat, size, size), false);
});

test('IoU 计算', () => {
  const a = Uint8Array.from([1, 1, 0, 0]);
  const b = Uint8Array.from([0, 1, 1, 0]);
  assert.equal(maskIoU(a, b), 1 / 3);
  assert.equal(maskIoU(new Uint8Array(4), new Uint8Array(4)), 0);
});
