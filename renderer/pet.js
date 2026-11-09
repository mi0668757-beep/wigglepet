const petEl = document.getElementById('pet');
const bubbleEl = document.getElementById('bubble');
const badgeEl = document.getElementById('badge');
const petContext = petEl.getContext('2d');

const BASE_SIZE = 220;
const MAX_SOURCE = 512;
// 画布比宠物大一圈，图层动起来不会被裁掉。
const PADDING = 30;
const GRAVITY = 1500;
const STRETCH_SPRING = 190;
const STRETCH_DAMPING = 13;
const TILT_SPRING = 70;
const TILT_DAMPING = 9;
const LEG_SWING = 0.4;
const ROLL_SPEED = 120;
const AUTO_LAYER_ACTION = 'breathe';
const LARGE_LAYER_SHARE = 0.45;

// 整只桌宠的动作：移动速度、节奏，以及按相位算出的姿态（y 向上为正，按 BASE_SIZE 的尺寸计）。
// hover 表示停下来也继续这个姿态，比如鱼不会落到地上。
const ACTIONS = {
  walk: {
    speed: 70,
    rate: 9,
    pose: (p) => ({ y: Math.abs(Math.sin(p)) * 6, tilt: Math.sin(p) * (sprite.legs.length ? 2.5 : 8) }),
  },
  hop: {
    speed: 55,
    rate: 5,
    pose: (p) => {
      const arc = Math.abs(Math.sin(p));
      return { y: arc * 46, scaleY: 1 + (arc - 0.4) * 0.14, scaleX: 1 - (arc - 0.4) * 0.1 };
    },
  },
  float: {
    speed: 18,
    rate: 1.6,
    hover: true,
    pose: (p) => ({ y: 22 + Math.sin(p) * 12, tilt: Math.sin(p * 0.7) * 4 }),
  },
  swim: {
    speed: 45,
    rate: 3.5,
    hover: true,
    pose: (p) => ({ y: 26 + Math.sin(p) * 12, tilt: Math.cos(p) * 9, scaleX: 1 + Math.sin(p * 2) * 0.03 }),
  },
  fly: {
    speed: 90,
    rate: 14,
    hover: true,
    pose: (p) => ({ y: 60 + Math.sin(p * 0.22) * 24, tilt: -5, scaleY: 1 + Math.sin(p) * 0.09 }),
  },
  roll: {
    speed: 80,
    rate: 0,
    pose: () => ({}),
  },
  crawl: {
    speed: 12,
    rate: 0,
    pose: () => ({}),
  },
  slide: {
    speed: 60,
    rate: 20,
    pose: (p) => ({ y: Math.abs(Math.sin(p)) * 1.5 }),
  },
  sway: {
    speed: 0,
    rate: 1.5,
    hover: true,
    pose: (p) => ({ tilt: Math.sin(p) * 6 }),
  },
  still: {
    speed: 0,
    rate: 0,
    pose: () => ({}),
  },
};

// 周期内的位置，0 到 1。
const cycle = (p) => (((p / (Math.PI * 2)) % 1) + 1) % 1;

// 摇摇欲坠：慢慢歪下去，越歪越抖，滑一下，再猛地晃回来，回弹几下。
function teeterPose(p) {
  const u = cycle(p);
  if (u < 0.72) {
    const lean = u / 0.72;
    return { rotate: lean * lean * 6.5 + Math.sin(p * 9) * lean * 0.9 };
  }
  if (u < 0.8) {
    const slip = (u - 0.72) / 0.08;
    return { rotate: 6.5 + slip * 2, x: slip * 0.018, y: -slip * 0.012 };
  }
  const back = (u - 0.8) / 0.2;
  return {
    rotate: 8.5 * Math.exp(-back * 5) * Math.cos(back * 14),
    x: 0.018 * (1 - back),
    y: -0.012 * (1 - back),
  };
}

// 图层在原位的局部动作。位移按图层自身的宽高计（y 向上为正），旋转单位是度。
// pivot 是旋转缩放的中心：bottom 像站在原地，center 像悬在空中，也可以指定比例位置。
// synced 的动作不错开相位：两只眼睛要一起眨，两只手要交替爬。
const LAYER_ACTIONS = {
  breathe: {
    rate: 2.2,
    pivot: 'bottom',
    pose: (p) => ({ scaleY: 1 + Math.sin(p) * 0.035, scaleX: 1 - Math.sin(p) * 0.02 }),
  },
  sway: {
    rate: 1.8,
    pivot: 'bottom',
    pose: (p) => ({ rotate: Math.sin(p) * 5 }),
  },
  nod: {
    rate: 2.4,
    pivot: 'center',
    pose: (p) => ({ rotate: Math.sin(p) * 5, y: Math.abs(Math.sin(p)) * 0.02 }),
  },
  peek: {
    rate: 1.2,
    pivot: 'bottom',
    pose: (p) => ({ y: Math.max(0, Math.sin(p)) * 0.16 }),
  },
  hop: {
    rate: 4,
    pivot: 'bottom',
    pose: (p) => {
      const arc = Math.abs(Math.sin(p));
      return { y: arc * 0.2, scaleY: 1 + (arc - 0.4) * 0.1, scaleX: 1 - (arc - 0.4) * 0.07 };
    },
  },
  float: {
    rate: 1.6,
    pivot: 'center',
    pose: (p) => ({ y: Math.sin(p) * 0.05, rotate: Math.sin(p * 0.7) * 3 }),
  },
  wiggle: {
    rate: 10,
    pivot: 'center',
    pose: (p) => ({ rotate: Math.sin(p) * 3 }),
  },
  crawl: {
    rate: 3.2,
    pivot: 'bottom',
    synced: true,
    pose: (p) => ({
      // 一耸一耸的同时，慢慢在原地来回挪。
      x: Math.sin(p) * 0.012 + Math.sin(p / 7) * 0.025,
      y: Math.abs(Math.sin(p)) * 0.012,
      rotate: Math.sin(p) * 1.4,
      scaleY: 1 - Math.abs(Math.cos(p)) * 0.012,
    }),
  },
  crawlHandA: {
    rate: 3.2,
    pivot: 'center',
    synced: true,
    pose: (p) => ({ x: Math.sin(p) * 0.1, y: Math.max(0, Math.cos(p)) * 0.26 }),
  },
  crawlHandB: {
    rate: 3.2,
    pivot: 'center',
    synced: true,
    pose: (p) => ({ x: Math.sin(p + Math.PI) * 0.1, y: Math.max(0, Math.cos(p + Math.PI)) * 0.26 }),
  },
  blink: {
    rate: 1.5,
    pivot: 'center',
    synced: true,
    pose: (p) => {
      const u = cycle(p);
      return u < 0.06 ? { scaleY: Math.max(0.1, Math.abs(u / 0.03 - 1)) } : {};
    },
  },
  wink: {
    rate: 1.1,
    pivot: 'center',
    pose: (p) => {
      const u = cycle(p);
      return u < 0.08 ? { scaleY: Math.max(0.1, Math.abs(u / 0.04 - 1)) } : {};
    },
  },
  write: {
    rate: 4.5,
    pivot: 'center',
    synced: true,
    pose: (p) => ({
      x: Math.sin(p) * 0.025,
      y: Math.sin(p * 2.3) * 0.012,
      rotate: Math.sin(p) * 1.5,
    }),
  },
  teeter: {
    rate: 1.05,
    pivot: { x: 0.42, y: 0.92 },
    synced: true,
    pose: teeterPose,
  },
  still: {
    rate: 0,
    pivot: 'bottom',
    pose: () => ({}),
  },
};

const body = {
  y: 0,
  vy: 0,
  stretch: 0,
  stretchSpeed: 0,
  tilt: 0,
  tiltSpeed: 0,
};

const drag = {
  active: false,
  moved: false,
  startX: 0,
  startY: 0,
  lastX: 0,
  lastAt: 0,
  speedX: 0,
};

const motion = {
  action: 'still',
  moving: false,
  direction: 1,
  until: 0,
  phase: 0,
  pending: 0,
  // 动作与静止之间的过渡，0 是静止，1 是完全进入动作姿态。
  blend: 0,
  roll: 0,
  legAngle: 0,
};

// 所有内容都画在同一个坐标系里（原图像素），bounds 是内容的范围。
const sprite = {
  base: null,
  body: null,
  legs: [],
  hipY: 0,
  layers: [],
  bounds: null,
  scale: 1,
  offsetX: 0,
  offsetY: 0,
};

let size = BASE_SIZE;
let unit = 1;
let lines = [];
let lastLine = '';
let bubbleTimer = null;
let moveEnabled = true;
let unread = 0;
let facing = 1;
let drawnAngle = null;
let liftY = 0;
let autoWhole = 'still';
let hitContext = null;

function canvasFromPixels(data, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d', { willReadFrequently: true }).putImageData(new ImageData(data, width, height), 0, 0);
  return canvas;
}

function layerFromMask(pixels, width, height, keep) {
  const data = new Uint8ClampedArray(pixels);
  for (let i = 0; i < width * height; i += 1) {
    if (!keep(i)) data[i * 4 + 3] = 0;
  }
  return canvasFromPixels(data, width, height);
}

async function loadImage(src) {
  const image = new Image();
  image.src = src;
  await image.decode();
  return image;
}

function imagePixels(image, maxSide = Infinity) {
  const shrink = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(image.naturalWidth * shrink);
  canvas.height = Math.round(image.naturalHeight * shrink);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

function addLayer(canvas, rect, action, index) {
  sprite.layers.push({
    canvas,
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    action: action ?? AUTO_LAYER_ACTION,
    // 跟随的图层序号，它移动时这一层一起移动，比如坐在纸箱上的猫。
    parent: rect.parent ?? null,
    // 错开相位，几个部分不会同步动。
    phaseOffset: index * 1.7,
  });
}

// 用户选好的构图：底图加留在原位的图层，整体待着，由图层各自动。
async function buildComposition(state) {
  const baseImage = await loadImage(state.image);
  const base = imagePixels(baseImage);
  sprite.base = canvasFromPixels(base.data, base.width, base.height);
  let box = contentBounds(base.data, base.width, base.height);
  for (const [index, layer] of state.layers.entries()) {
    const { data, width, height } = imagePixels(await loadImage(layer.image));
    addLayer(canvasFromPixels(data, width, height), layer, state.layerActions[index], index);
    // 底图可能是空的，这时范围完全由图层决定，桌宠才不会缩在一角。
    const current = box ?? layer;
    const right = Math.max(current.x + current.width, layer.x + layer.width);
    const bottom = Math.max(current.y + current.height, layer.y + layer.height);
    const left = Math.min(current.x, layer.x);
    const top = Math.min(current.y, layer.y);
    box = { x: left, y: top, width: right - left, height: bottom - top };
  }
  sprite.bounds = box ?? { x: 0, y: 0, width: base.width, height: base.height };
  return { background: 'transparent', autoWhole: 'still' };
}

// 直接导入的图：互不相连的几个对象留在原位当图层，只有一个对象时才是能走动的单个角色。
async function buildImported(state) {
  const { data, width, height } = imagePixels(await loadImage(state.image), MAX_SOURCE);
  const background = removeBackground(data, width, height);
  const objects = background === 'failed' ? [] : findObjects(data, width, height);

  if (objects.length > 1) {
    objects.forEach((object, index) => {
      addLayer(canvasFromPixels(object.data, object.width, object.height), object, state.layerActions[index], index);
    });
    sprite.bounds = contentBounds(data, width, height);
    return { background, autoWhole: 'still' };
  }

  const object = objects[0] ?? { x: 0, y: 0, width, height, area: width * height, data };
  sprite.bounds = { x: object.x, y: object.y, width: object.width, height: object.height };
  sprite.base = canvasFromPixels(new Uint8ClampedArray(object.data), object.width, object.height);
  const found = background === 'failed' ? null : detectLegs(object.data, object.width, object.height);
  if (found) {
    const [left, right] = found.legs;
    sprite.hipY = found.hipY;
    sprite.body = layerFromMask(object.data, object.width, object.height, (i) => left.mask[i] !== 1 && right.mask[i] !== 1);
    sprite.legs = found.legs.map((leg) => ({
      pivotX: leg.pivotX,
      canvas: layerFromMask(object.data, object.width, object.height, (i) => leg.mask[i] > 0),
    }));
  }
  return {
    background,
    autoWhole: background === 'failed' ? 'still' : suggestAction(object.width, object.height, object.area, Boolean(found)),
  };
}

function applySpriteTransform(context, ratio) {
  const scale = sprite.scale * ratio;
  context.setTransform(
    scale,
    0,
    0,
    scale,
    (sprite.offsetX + PADDING) * ratio - sprite.bounds.x * scale,
    (sprite.offsetY + PADDING) * ratio - sprite.bounds.y * scale,
  );
}

function drawBase(context, angle) {
  const { x, y } = sprite.bounds;
  if (sprite.legs.length) {
    sprite.legs.forEach((leg, index) => {
      context.save();
      context.translate(x + leg.pivotX, y + sprite.hipY);
      context.rotate(index === 0 ? angle : -angle);
      context.translate(-(x + leg.pivotX), -(y + sprite.hipY));
      context.drawImage(leg.canvas, x, y);
      context.restore();
    });
    context.drawImage(sprite.body, x, y);
  } else if (sprite.base) {
    // 组合图的底图用整张的坐标，单个对象已裁边，要放回 bounds 的位置。
    const isWholeImage = sprite.layers.length > 0;
    context.drawImage(sprite.base, isWholeImage ? 0 : x, isWholeImage ? 0 : y);
  }
}

function layerPivot(layer, pivot) {
  if (pivot === 'center') return { x: layer.x + layer.width / 2, y: layer.y + layer.height / 2 };
  if (pivot === 'bottom') return { x: layer.x + layer.width / 2, y: layer.y + layer.height };
  return { x: layer.x + layer.width * pivot.x, y: layer.y + layer.height * pivot.y };
}

// 先应用跟随对象的变换，再应用自己的，这样猫会跟着纸箱一起晃。
function applyLayerPose(context, layer, now) {
  if (layer.parent !== null) applyLayerPose(context, sprite.layers[layer.parent], now);
  const definition = LAYER_ACTIONS[layer.action] ?? LAYER_ACTIONS.still;
  const phase = (now / 1000) * definition.rate + (definition.synced ? 0 : layer.phaseOffset);
  const pose = definition.pose(phase);
  const pivot = layerPivot(layer, definition.pivot);
  // 越大的部分动作幅度越小：大本子稍微一转，边缘就移动很远，会露出后面的补底。
  const share = Math.max(layer.width, layer.height) / Math.max(sprite.bounds.width, sprite.bounds.height);
  const damp = Math.min(1, LARGE_LAYER_SHARE / share);
  context.translate(pivot.x + (pose.x ?? 0) * layer.width * damp, pivot.y - (pose.y ?? 0) * layer.height * damp);
  if (pose.rotate) context.rotate((pose.rotate * damp * Math.PI) / 180);
  context.scale(1 + ((pose.scaleX ?? 1) - 1) * damp, 1 + ((pose.scaleY ?? 1) - 1) * damp);
  context.translate(-pivot.x, -pivot.y);
}

function drawLayer(context, layer, now) {
  context.save();
  applyLayerPose(context, layer, now);
  context.drawImage(layer.canvas, layer.x, layer.y, layer.width, layer.height);
  context.restore();
}

function drawSprite(angle, now) {
  const ratio = window.devicePixelRatio;
  petContext.setTransform(1, 0, 0, 1, 0, 0);
  petContext.clearRect(0, 0, petEl.width, petEl.height);
  applySpriteTransform(petContext, ratio);
  drawBase(petContext, angle);
  for (const layer of sprite.layers) drawLayer(petContext, layer, now);
}

function buildHitMask() {
  const hitCanvas = document.createElement('canvas');
  hitCanvas.width = size;
  hitCanvas.height = size;
  hitContext = hitCanvas.getContext('2d', { willReadFrequently: true });
  const scale = sprite.scale;
  hitContext.setTransform(scale, 0, 0, scale, sprite.offsetX - sprite.bounds.x * scale, sprite.offsetY - sprite.bounds.y * scale);
  drawBase(hitContext, 0);
  for (const layer of sprite.layers) hitContext.drawImage(layer.canvas, layer.x, layer.y, layer.width, layer.height);
}

// 把窗口坐标换算成宠物未移动时的坐标，超出范围返回 null。
function toPetPoint(position) {
  if (!position) return null;
  let x = position.x - petEl.offsetLeft;
  const y = position.y - petEl.offsetTop - liftY - PADDING;
  if (facing < 0) x = size + 2 * PADDING - 1 - x;
  x -= PADDING;
  if (x < 0 || y < 0 || x >= size || y >= size) return null;
  return { x: Math.floor(x), y: Math.floor(y) };
}

function isOverPet(position) {
  const point = toPetPoint(position);
  if (!point || !hitContext) return false;
  return hitContext.getImageData(point.x, point.y, 1, 1).data[3] > 10;
}

// 光标下最上层的图层序号，右键菜单用它决定改哪个部分。
function layerAt(position) {
  const point = toPetPoint(position);
  if (!point) return null;
  const sourceX = (point.x - sprite.offsetX) / sprite.scale + sprite.bounds.x;
  const sourceY = (point.y - sprite.offsetY) / sprite.scale + sprite.bounds.y;
  for (let index = sprite.layers.length - 1; index >= 0; index -= 1) {
    const layer = sprite.layers[index];
    const u = (sourceX - layer.x) / layer.width;
    const v = (sourceY - layer.y) / layer.height;
    if (u < 0 || v < 0 || u >= 1 || v >= 1) continue;
    const pixel = layer.canvas
      .getContext('2d')
      .getImageData(Math.floor(u * layer.canvas.width), Math.floor(v * layer.canvas.height), 1, 1).data;
    if (pixel[3] > 10) return index;
  }
  return null;
}

function hop(power = 430) {
  if (body.y !== 0) return;
  body.vy = -power * Math.sqrt(unit);
  body.y = -1;
  body.stretchSpeed += 3.2;
}

// 组合图不翻转：翻过来水印和文字都是反的，图层的相对位置也会变。
function faceDirection() {
  if (!sprite.layers.length) facing = motion.direction;
}

function startMoving(seconds) {
  if (ACTIONS[motion.action].speed === 0) return;
  motion.moving = true;
  motion.direction = Math.random() < 0.5 ? 1 : -1;
  motion.until = performance.now() + seconds * 1000;
  faceDirection();
}

function stopMoving() {
  motion.moving = false;
}

function setWholeAction(action) {
  stopMoving();
  motion.action = action;
  motion.phase = 0;
  facing = 1;
  petEl.style.transformOrigin =
    action === 'roll'
      ? `${size / 2 + PADDING}px ${sprite.offsetY + (size - sprite.offsetY) / 2 + PADDING}px`
      : '50% 100%';
  if (action !== 'roll') motion.roll = 0;
}

function say(text, duration = 2600) {
  bubbleEl.textContent = text;
  bubbleEl.classList.add('show');
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => bubbleEl.classList.remove('show'), duration);
}

function sayRandom() {
  const choices = lines.filter((line) => line !== lastLine);
  if (!choices.length) return;
  lastLine = choices[Math.floor(Math.random() * choices.length)];
  say(lastLine);
}

function scheduleIdleAction() {
  setTimeout(() => {
    if (!drag.active && !motion.moving) {
      const canMove = moveEnabled && ACTIONS[motion.action].speed > 0;
      if (canMove && Math.random() < 0.65) startMoving(2 + Math.random() * 4);
      else if (Math.random() < 0.2) sayRandom();
    }
    scheduleIdleAction();
  }, 4000 + Math.random() * 8000);
}

function stepMotion(dt, now) {
  const definition = ACTIONS[motion.action];
  if (motion.moving && now > motion.until) stopMoving();
  const moving = motion.moving && !drag.active;
  const posing = !drag.active && (moving || definition.hover);

  motion.blend += ((posing ? 1 : 0) - motion.blend) * Math.min(1, dt * 8);
  if (motion.blend < 0.001) motion.blend = 0;
  if (posing) motion.phase += definition.rate * dt;

  if (moving) {
    motion.pending += motion.direction * definition.speed * unit * dt;
    const move = Math.trunc(motion.pending);
    if (move !== 0) {
      motion.pending -= move;
      window.desk.move(move).then(({ hitEdge }) => {
        if (hitEdge && motion.moving) {
          motion.direction = -Math.sign(move);
          faceDirection();
        }
      });
    }
  }

  if (motion.action === 'roll') {
    if (moving) {
      motion.roll += motion.direction * ROLL_SPEED * dt;
    } else {
      // 停下后转回正面朝上。
      const upright = Math.round(motion.roll / 360) * 360;
      motion.roll += (upright - motion.roll) * Math.min(1, dt * 6);
    }
  }

  motion.legAngle =
    motion.action === 'walk' && sprite.legs.length ? Math.sin(motion.phase) * LEG_SWING * motion.blend : 0;
  if (Math.abs(motion.legAngle) < 0.002) motion.legAngle = 0;

  const pose = definition.pose(motion.phase);
  return {
    y: (pose.y ?? 0) * unit * motion.blend,
    tilt: (pose.tilt ?? 0) * motion.blend * facing + motion.roll,
    scaleX: 1 + ((pose.scaleX ?? 1) - 1) * motion.blend,
    scaleY: 1 + ((pose.scaleY ?? 1) - 1) * motion.blend,
  };
}

function step(dt, now) {
  const stretchTarget = drag.active ? 0.07 : 0;
  body.stretchSpeed += (-STRETCH_SPRING * (body.stretch - stretchTarget) - STRETCH_DAMPING * body.stretchSpeed) * dt;
  body.stretch += body.stretchSpeed * dt;

  drag.speedX *= Math.pow(0.002, dt);
  const tiltTarget = drag.active ? Math.max(-22, Math.min(22, drag.speedX * 0.025)) : 0;
  body.tiltSpeed += (-TILT_SPRING * (body.tilt - tiltTarget) - TILT_DAMPING * body.tiltSpeed) * dt;
  body.tilt += body.tiltSpeed * dt;

  if (body.y !== 0 && !drag.active) {
    body.vy += GRAVITY * dt;
    body.y += body.vy * dt;
    if (body.y >= 0) {
      body.stretchSpeed -= Math.min(body.vy, 700) * 0.008;
      body.y = 0;
      body.vy = 0;
    }
  }

  const pose = stepMotion(dt, now);
  // 有图层时每帧都要重画，单个角色只在腿的角度变化时才画。
  if (sprite.layers.length || motion.legAngle !== drawnAngle) {
    drawSprite(motion.legAngle, now);
    drawnAngle = motion.legAngle;
  }

  // 组合图的动作交给图层，整体只保留很轻的呼吸，不摇晃。
  const composed = sprite.layers.length > 0;
  const seconds = now / 1000;
  const still = motion.action === 'still';
  const breath = composed ? 0 : Math.sin(seconds * 2.2) * 0.014;
  const sway = still ? 0 : Math.sin(seconds * 0.9) * 1.4;
  const scaleY = (1 + body.stretch + breath) * pose.scaleY;
  const scaleX = (1 - body.stretch * 0.8 - breath * 0.6) * pose.scaleX * facing;
  liftY = body.y - pose.y;
  petEl.style.transform =
    `translateY(${liftY.toFixed(1)}px) rotate(${(sway + body.tilt + pose.tilt).toFixed(2)}deg) ` +
    `scale(${scaleX.toFixed(4)}, ${scaleY.toFixed(4)})`;
}

let previous = performance.now();
function frame(now) {
  // 限制步长，窗口被挂起后恢复时动画不会跳变。
  step(Math.min((now - previous) / 1000, 0.05), now);
  previous = now;
  requestAnimationFrame(frame);
}

petEl.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  petEl.setPointerCapture(event.pointerId);
  Object.assign(drag, {
    active: true,
    moved: false,
    startX: event.screenX,
    startY: event.screenY,
    lastX: event.screenX,
    lastAt: event.timeStamp,
    speedX: 0,
  });
  window.desk.dragStart();
});

petEl.addEventListener('pointermove', (event) => {
  if (!drag.active) return;
  if (Math.hypot(event.screenX - drag.startX, event.screenY - drag.startY) > 4) drag.moved = true;
  const elapsed = (event.timeStamp - drag.lastAt) / 1000;
  if (elapsed > 0) drag.speedX = (event.screenX - drag.lastX) / elapsed;
  drag.lastX = event.screenX;
  drag.lastAt = event.timeStamp;
});

function endDrag() {
  if (!drag.active) return;
  drag.active = false;
  window.desk.dragEnd();
  stopMoving();
  if (drag.moved) {
    // 松手时轻轻落下。
    body.y = -18 * unit;
    body.vy = 0;
    return;
  }
  hop();
  if (unread > 0) window.desk.openWeChat();
  else sayRandom();
}

petEl.addEventListener('pointerup', endDrag);
petEl.addEventListener('pointercancel', endDrag);
petEl.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  window.desk.showMenu(layerAt({ x: event.clientX, y: event.clientY }));
});

function showUnread(count, rose) {
  unread = count;
  badgeEl.textContent = count > 99 ? '99+' : String(count);
  badgeEl.classList.toggle('show', count > 0);
  if (!rose) return;
  stopMoving();
  say(`叮咚～微信有 ${count} 条消息在等你哦`, 5000);
  [0, 700, 1400].forEach((delay) => setTimeout(() => hop(), delay));
}

function layout() {
  unit = size / BASE_SIZE;
  const ratio = window.devicePixelRatio;
  const canvasWidth = size + 2 * PADDING;
  const canvasHeight = size + PADDING;
  petEl.width = canvasWidth * ratio;
  petEl.height = canvasHeight * ratio;
  petEl.style.width = `${canvasWidth}px`;
  petEl.style.height = `${canvasHeight}px`;
  petEl.style.left = `${(window.innerWidth - canvasWidth) / 2}px`;
  bubbleEl.style.bottom = `${size + 12}px`;
  badgeEl.style.left = `${(window.innerWidth + size) / 2 - 24}px`;
  badgeEl.style.bottom = `${size - 34}px`;
}

async function start() {
  const state = await window.desk.loadPet();
  size = state.size;
  lines = state.lines ?? [];
  moveEnabled = state.moveEnabled;
  layout();

  const { background, autoWhole: suggested } = state.layers ? await buildComposition(state) : await buildImported(state);
  autoWhole = suggested;
  sprite.scale = Math.min(size / sprite.bounds.width, size / sprite.bounds.height);
  sprite.offsetX = (size - sprite.bounds.width * sprite.scale) / 2;
  sprite.offsetY = size - sprite.bounds.height * sprite.scale;
  buildHitMask();

  setWholeAction(state.wholeAction ?? autoWhole);
  if (background === 'failed') say('背景太复杂抠不干净，可以重新导入，手动选会动的部分', 6000);

  // 页面可能是换形象后刷新的，先把窗口恢复成穿透，和这里的初始状态一致。
  let interactive = false;
  window.desk.setInteractive(false);
  window.desk.onCursor((position) => {
    const over = isOverPet(position);
    if (over === interactive) return;
    interactive = over;
    window.desk.setInteractive(over);
  });
  window.desk.onMoveEnabled((value) => {
    moveEnabled = value;
    if (!value) stopMoving();
  });
  window.desk.onWholeAction((action) => setWholeAction(action ?? autoWhole));
  window.desk.onLayerAction(({ index, action }) => {
    sprite.layers[index].action = action ?? AUTO_LAYER_ACTION;
  });
  window.desk.onBadge(({ count, rose }) => showUnread(count, rose));
  window.desk.onRemind((text) => {
    stopMoving();
    say(text, 8000);
    [0, 700].forEach((delay) => setTimeout(() => hop(), delay));
  });

  requestAnimationFrame(frame);
  scheduleIdleAction();
  window.desk.petReady({ whole: autoWhole, layer: AUTO_LAYER_ACTION });
}

start();
