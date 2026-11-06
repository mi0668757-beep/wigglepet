const assert = require('node:assert/strict');
const { test } = require('node:test');
const { removeBackground, contentBounds, detectLegs, findObjects, suggestAction } = require('../renderer/sprite');

const WHITE = [255, 255, 255, 255];
const CLEAR = [0, 0, 0, 0];
const BODY = [240, 150, 80, 255];

// 用字符画造图：. 是底色，# 是角色，其他字符按 palette 取色。
function image(rows, base = CLEAR, palette = {}) {
  const height = rows.length;
  const width = rows[0].length;
  const data = new Uint8ClampedArray(width * height * 4);
  rows.forEach((row, y) => {
    [...row].forEach((char, x) => {
      const color = char === '.' ? base : char === '#' ? BODY : palette[char];
      data.set(color, (y * width + x) * 4);
    });
  });
  return { data, width, height };
}

const alpha = ({ data, width }, x, y) => data[(y * width + x) * 4 + 3];

const PERSON = [
  '...######...',
  '...######...',
  '...######...',
  '.##########.',
  '.##########.',
  '.##..##..##.',
  '.....##.....',
  '..####.####.',
  '..###...###.',
  '..###...###.',
  '..###...###.',
  '..###...###.',
];

test('透明背景的图不做处理', () => {
  const pic = image(['....', '.##.', '....']);
  assert.equal(removeBackground(pic.data, pic.width, pic.height), 'transparent');
  assert.equal(alpha(pic, 1, 1), 255);
});

test('纯色背景被抠掉，角色保留', () => {
  const pic = image(['.....', '.###.', '.###.', '.....'], WHITE);
  assert.equal(removeBackground(pic.data, pic.width, pic.height), 'removed');
  assert.equal(alpha(pic, 0, 0), 0);
  assert.equal(alpha(pic, 2, 1), 255);
});

test('被角色包住的同色区域不会被抠掉', () => {
  const pic = image(['.......', '.#####.', '.#www#.', '.#####.', '.......'], WHITE, { w: WHITE });
  assert.equal(removeBackground(pic.data, pic.width, pic.height), 'removed');
  assert.equal(alpha(pic, 3, 2), 255);
});

test('接近背景的浅色物体（浅粉地毯）不会被当成背景抠掉', () => {
  const pic = image(['.....', '.rrr.', '.rrr.', '.....'], WHITE, { r: [253, 225, 230, 255] });
  assert.equal(removeBackground(pic.data, pic.width, pic.height), 'removed');
  assert.equal(alpha(pic, 0, 0), 0);
  assert.equal(alpha(pic, 2, 1), 255);
});

// 白底上一只白猫：深色描边围成方块，描边上开了缝。
function whiteCat(gap) {
  const size = 400;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let y = 100; y < 300; y += 1) {
    for (let x = 100; x < 300; x += 1) {
      const onOutline = x < 106 || x >= 294 || y < 106 || y >= 294;
      const inGap = y < 106 && x >= 200 && x < 200 + gap;
      if (onOutline && !inGap) data.set([70, 40, 20, 255], (y * size + x) * 4);
    }
  }
  return { data, width: size, height: size };
}

test('背景不会从描边的窄缝流进同色的身体', () => {
  const pic = whiteCat(6);
  assert.equal(removeBackground(pic.data, pic.width, pic.height), 'removed');
  assert.equal(alpha(pic, 5, 5), 0);
  assert.equal(alpha(pic, 95, 200), 0);
  assert.equal(alpha(pic, 200, 200), 255);
});

test('描边开了大口时，里面算作背景', () => {
  const pic = whiteCat(120);
  removeBackground(pic.data, pic.width, pic.height);
  assert.equal(alpha(pic, 200, 200), 0);
});

test('贴着物体的窄背景也会被去掉', () => {
  const pic = whiteCat(0);
  removeBackground(pic.data, pic.width, pic.height);
  // 紧贴描边外侧的一圈。
  assert.equal(alpha(pic, 98, 200), 0);
  assert.equal(alpha(pic, 301, 200), 0);
});

test('留白很窄的图也能去掉四周的背景', () => {
  const size = 400;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let y = 2; y < 398; y += 1) {
    for (let x = 2; x < 398; x += 1) data.set([240, 150, 80, 255], (y * size + x) * 4);
  }
  const pic = { data, width: size, height: size };
  assert.equal(removeBackground(pic.data, size, size), 'removed');
  assert.equal(alpha(pic, 0, 0), 0);
  assert.equal(alpha(pic, 1, 200), 0);
  assert.equal(alpha(pic, 200, 200), 255);
});

test('四角颜色各不相同时放弃抠图', () => {
  const pic = image(['a..b', '....', 'c..d'], WHITE, {
    a: [255, 0, 0, 255],
    b: [0, 255, 0, 255],
    c: [0, 0, 255, 255],
    d: [20, 20, 20, 255],
  });
  assert.equal(removeBackground(pic.data, pic.width, pic.height), 'failed');
});

test('裁到内容边界', () => {
  const pic = image(['.....', '..#..', '..##.', '.....']);
  assert.deepEqual(contentBounds(pic.data, pic.width, pic.height), { x: 2, y: 1, width: 2, height: 2 });
});

test('全透明的图没有内容边界', () => {
  const pic = image(['...', '...']);
  assert.equal(contentBounds(pic.data, pic.width, pic.height), null);
});

test('两腿分开的角色能找到胯部和两条腿', () => {
  const pic = image(PERSON);
  const found = detectLegs(pic.data, pic.width, pic.height);
  assert.ok(found);
  assert.equal(found.hipY, 7);
  assert.equal(found.legs.length, 2);
  const [left, right] = found.legs;
  assert.ok(left.pivotX < 6 && right.pivotX > 6);
  // 左腿掩码不含右腿，也不含手臂。
  assert.equal(left.mask[10 * pic.width + 3], 1);
  assert.equal(left.mask[10 * pic.width + 9], 0);
  assert.equal(left.mask[5 * pic.width + 1], 0);
});

test('没有腿缝的团子回退为整体摇摆', () => {
  const pic = image(['######', '######', '######', '######', '######', '######']);
  assert.equal(detectLegs(pic.data, pic.width, pic.height), null);
});

test('两脚在底部连在一起时不拆腿', () => {
  const pic = image(['######', '######', '##..##', '##..##', '######', '######']);
  assert.equal(detectLegs(pic.data, pic.width, pic.height), null);
});

test('互不相连的两个对象被分开，从左到右排序并各自裁边', () => {
  const pic = image([
    '..............',
    '.####....#####',
    '.####....#####',
    '.####....#####',
    '.........#####',
    '..............',
  ]);
  const objects = findObjects(pic.data, pic.width, pic.height);
  assert.equal(objects.length, 2);
  assert.deepEqual(
    objects.map(({ x, y, width, height }) => [x, y, width, height]),
    [
      [1, 1, 4, 3],
      [9, 1, 5, 4],
    ],
  );
  assert.equal(objects[0].data.length, 4 * 3 * 4);
});

test('贴近对象的小碎片并入对象，远处的碎片丢弃', () => {
  const rows = Array.from({ length: 40 }, () => '.'.repeat(40).split(''));
  for (let y = 10; y < 30; y += 1) {
    for (let x = 5; x < 25; x += 1) rows[y][x] = '#';
  }
  rows[8][10] = '#';
  rows[1][38] = '#';
  const pic = image(rows.map((row) => row.join('')));
  const objects = findObjects(pic.data, pic.width, pic.height);
  assert.equal(objects.length, 1);
  assert.equal(objects[0].y, 8);
  assert.equal(objects[0].area, 401);
  assert.equal(objects[0].width, 20);
});

test('对象数量有上限，保留最大的几个', () => {
  const rows = Array.from({ length: 6 }, () => '#.'.repeat(10));
  const pic = image(rows);
  assert.equal(findObjects(pic.data, pic.width, pic.height, 3).length, 3);
});

test('透明的图没有对象', () => {
  const pic = image(['...', '...']);
  assert.deepEqual(findObjects(pic.data, pic.width, pic.height), []);
});

test('按轮廓推荐动作', () => {
  assert.equal(suggestAction(100, 100, 5000, true), 'walk');
  assert.equal(suggestAction(200, 100, 15000, false), 'slide');
  assert.equal(suggestAction(50, 200, 8000, false), 'sway');
  assert.equal(suggestAction(100, 100, 7800, false), 'hop');
  assert.equal(suggestAction(100, 100, 3000, false), 'sway');
});
