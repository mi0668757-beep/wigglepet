const { app, BrowserWindow, Menu, dialog, ipcMain, net, protocol, screen, session } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { WECHAT_BUNDLE_ID, readBadge } = require('./badge');
const { loadConfig, saveConfig, recognize } = require('./vision');
const { DEFAULT_REMINDERS, nextReminder } = require('./reminders');

// 分割模型要用 fetch 读取本地 wasm，还要安全上下文才能缓存模型，file:// 都不满足。
protocol.registerSchemesAsPrivileged([
  { scheme: 'pet', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const MARGIN = 24;
const BADGE_POLL_MS = 3000;
const REMINDER_POLL_MS = 30000;
const WATER_INTERVALS = { 60: '1 小时', 90: '1.5 小时', 120: '2 小时' };
const DEFAULT_PET = 'placeholder';
const SIZES = { small: { label: '小', px: 110 }, medium: { label: '中', px: 150 }, large: { label: '大', px: 220 } };
// 整只桌宠的动作，会在屏幕上移动。
const WHOLE_ACTIONS = {
  walk: '走路',
  hop: '蹦跳',
  float: '漂浮',
  swim: '游动',
  fly: '飞行',
  roll: '滚动',
  crawl: '慢慢爬',
  slide: '平移',
  sway: '摇摆',
  still: '待着',
};
// 图层在原位的局部动作。
const LAYER_ACTIONS = {
  breathe: '呼吸',
  sway: '摇摆',
  nod: '点头',
  peek: '探头',
  hop: '蹦跳',
  float: '漂浮',
  wiggle: '抖动',
  crawl: '爬·身体',
  crawlHandA: '爬·先迈的手',
  crawlHandB: '爬·后迈的手',
  blink: '眨眼',
  wink: '单独眨眼',
  teeter: '摇摇欲坠',
  write: '写字',
  still: '不动',
};
const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};
const SERVED_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
};
const DEFAULT_LINES = ['嘿嘿，你来啦～', '今天也辛苦啦，摸摸头', '要不要歇一小会儿呀？', '你认真的样子好厉害！', '再戳我一下试试嘛～'];

const userPetsDir = () => path.join(app.getPath('userData'), 'pets');
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
const userVisionFile = () => path.join(app.getPath('userData'), 'vision.env');
// 用户自己填的优先；内部分享版可以在安装包里放一份 internal.env；开发时读项目里的 .env。
const visionFiles = () => [
  userVisionFile(),
  ...(app.isPackaged ? [path.join(process.resourcesPath, 'internal.env')] : []),
  path.join(__dirname, '.env'),
];

function loadSettings() {
  const defaults = {
    pet: DEFAULT_PET,
    size: 'medium',
    move: true,
    wechatAlert: false,
    actions: {},
    reminders: { enabled: true, waterMinutes: 90 },
    reminderState: {},
  };
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) };
  } catch {
    return defaults;
  }
}

function saveSettings(settings) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
}

function imageDataUrl(filePath) {
  const data = fs.readFileSync(filePath).toString('base64');
  return `data:${MIME[path.extname(filePath).toLowerCase()]};base64,${data}`;
}

// 图片转成 data URL，渲染进程才能读取像素做抠图和腿部识别。
function loadPet(id) {
  const dir = [path.join(userPetsDir(), id), path.join(__dirname, 'pets', id)].find((candidate) =>
    fs.existsSync(path.join(candidate, 'pet.json')),
  );
  if (!dir) return id === DEFAULT_PET ? null : loadPet(DEFAULT_PET);
  const pet = JSON.parse(fs.readFileSync(path.join(dir, 'pet.json'), 'utf8'));
  // 早期版本抠出来的散开对象没有底图，不再支持，退回默认形象。
  if (!pet.image) return loadPet(DEFAULT_PET);
  return {
    ...pet,
    id,
    image: imageDataUrl(path.join(dir, pet.image)),
    layers: pet.layers?.map((layer) => ({ ...layer, image: imageDataUrl(path.join(dir, layer.image)) })),
  };
}

const displayName = (filePath) => path.basename(filePath, path.extname(filePath)).slice(0, 12);

function importPet(filePath) {
  const id = `pet-${Date.now()}`;
  const dir = path.join(userPetsDir(), id);
  const ext = path.extname(filePath).toLowerCase();
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(filePath, path.join(dir, `pet${ext}`));
  fs.writeFileSync(
    path.join(dir, 'pet.json'),
    JSON.stringify({ name: displayName(filePath), image: `pet${ext}`, lines: DEFAULT_LINES }, null, 2),
  );
  return id;
}

function writePng(dir, file, dataUrl) {
  fs.writeFileSync(path.join(dir, file), Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'));
}

// 点选抠图的结果：一张补好洞的底图，加上留在原位的几个图层。
function saveComposition({ name, base, layers }, sourcePath) {
  const id = `pet-${Date.now()}`;
  const dir = path.join(userPetsDir(), id);
  fs.mkdirSync(dir, { recursive: true });
  // 留一份原图，之后可以重新生成。
  fs.copyFileSync(sourcePath, path.join(dir, `source${path.extname(sourcePath).toLowerCase()}`));
  writePng(dir, 'base.png', base);
  const saved = layers.map((layer, index) => {
    const image = `layer-${index}.png`;
    writePng(dir, image, layer.png);
    return { image, x: layer.x, y: layer.y, width: layer.width, height: layer.height, parent: layer.parent };
  });
  fs.writeFileSync(
    path.join(dir, 'pet.json'),
    JSON.stringify({ name: name || '桌宠', image: 'base.png', layers: saved, lines: DEFAULT_LINES }, null, 2),
  );
  return id;
}

// 窗口比宠物大一圈，留出气泡和动作的空间。
function windowSize(size) {
  return { width: Math.max(size + 60, 210), height: size + 130 };
}

function clampToArea(x, y, area, size) {
  const { width, height } = windowSize(size);
  const inset = (width - size) / 2;
  return {
    x: Math.round(Math.max(area.x - inset, Math.min(x, area.x + area.width - width + inset))),
    y: Math.round(Math.max(area.y - (height - size), Math.min(y, area.y + area.height - height))),
  };
}

app.whenReady().then(() => {
  app.dock?.hide();
  // 加上跨源隔离的响应头后，wasm 才能用多线程，抠图分析更快。
  protocol.handle('pet', async (request) => {
    const file = path.normalize(path.join(__dirname, decodeURIComponent(new URL(request.url).pathname)));
    if (!file.startsWith(__dirname + path.sep)) return new Response(null, { status: 403 });
    if (!fs.existsSync(file)) return new Response(null, { status: 404 });
    const response = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(response.headers);
    // Windows 按注册表判断文件类型，.mjs 和 .wasm 可能读错，导致模块加载失败。
    const contentType = SERVED_TYPES[path.extname(file).toLowerCase()];
    if (contentType) headers.set('Content-Type', contentType);
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
    return new Response(response.body, { status: response.status, headers });
  });

  // 国内镜像不返回跨域响应头，页面读不到模型文件，只给这个域名补上。
  session.defaultSession.webRequest.onHeadersReceived(
    { urls: ['https://hf-mirror.com/*', 'https://*.hf-mirror.com/*'] },
    ({ responseHeaders }, callback) => {
      callback({ responseHeaders: { ...responseHeaders, 'Access-Control-Allow-Origin': ['*'] } });
    },
  );

  const settings = loadSettings();
  const arg = process.argv.find((a) => a.startsWith('--pet='));
  let pet = loadPet(arg ? arg.slice('--pet='.length) : settings.pet);
  let win = null;
  let autoActions = { whole: 'still', layer: 'breathe' };
  let dragOffset = null;
  let lastCursor = null;
  let unreadCount = 0;

  const petSize = () => SIZES[settings.size].px;
  const update = (changes) => {
    Object.assign(settings, changes);
    saveSettings(settings);
  };
  const petActions = () => settings.actions[pet.id] ?? {};
  const updatePetActions = (changes) => {
    update({ actions: { ...settings.actions, [pet.id]: { ...petActions(), ...changes } } });
  };

  // 换形象或退出时，旧窗口可能还有请求在路上，这些请求直接忽略。
  const isCurrent = (event) => win && !win.isDestroyed() && event.sender === win.webContents;

  function createWindow() {
    const size = petSize();
    const area = screen.getPrimaryDisplay().workArea;
    const { width, height } = windowSize(size);
    const position = clampToArea(
      area.x + area.width - width - MARGIN,
      area.y + area.height - height,
      area,
      size,
    );
    const next = new BrowserWindow({
      ...position,
      width,
      height,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      // panel 窗口点击时不会抢走当前应用的焦点。
      type: process.platform === 'darwin' ? 'panel' : undefined,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        backgroundThrottling: false,
      },
    });
    next.setAlwaysOnTop(true, 'floating');
    next.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    next.setIgnoreMouseEvents(true);
    next.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    return next;
  }

  // 大小变了或换了形象都要重建，新窗口先建好再关旧的，否则应用会因为没有窗口而退出。
  function rebuildWindow() {
    const old = win;
    dragOffset = null;
    lastCursor = null;
    win = createWindow();
    old?.destroy();
  }

  function switchPet(id) {
    update({ pet: id });
    pet = loadPet(id);
    rebuildWindow();
  }

  let editor = null;
  let editorImage = null;

  async function pickImage() {
    app.focus({ steal: true });
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'webp', 'jpg', 'jpeg'] }],
    });
    return canceled ? null : filePaths[0];
  }

  function openEditor(filePath) {
    editor?.destroy();
    editorImage = filePath;
    editor = new BrowserWindow({
      width: 1100,
      height: 780,
      minWidth: 760,
      minHeight: 520,
      title: '选择会动的部分',
      webPreferences: {
        preload: path.join(__dirname, 'editor-preload.js'),
        // 窗口被挡住时也要继续分析，用户可能切去别的应用等它做完。
        backgroundThrottling: false,
      },
    });
    editor.on('closed', () => {
      editor = null;
    });
    editor.loadURL('pet://app/renderer/editor.html');
    app.focus({ steal: true });
  }

  // 窗口默认点击穿透，收不到鼠标事件，所以由主进程轮询光标位置，
  // 再让渲染进程判断光标是否压在宠物的不透明像素上。
  setInterval(() => {
    if (!win || win.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();
    const bounds = win.getBounds();
    if (dragOffset) {
      const area = screen.getDisplayNearestPoint(cursor).workArea;
      const position = clampToArea(cursor.x - dragOffset.x, cursor.y - dragOffset.y, area, petSize());
      win.setBounds({ ...position, width: bounds.width, height: bounds.height });
      return;
    }
    const x = cursor.x - bounds.x;
    const y = cursor.y - bounds.y;
    const inside = x >= 0 && y >= 0 && x < bounds.width && y < bounds.height;
    const key = inside ? `${x},${y}` : null;
    if (key === lastCursor) return;
    lastCursor = key;
    win.webContents.send('cursor', inside ? { x, y } : null);
  }, 16);

  // 刚开启时的存量未读只显示数字，只有数字增加才提醒。
  let lastPolled = null;
  const sendUnread = (rose) => {
    if (win && !win.isDestroyed()) win.webContents.send('badge', { count: unreadCount, rose });
  };
  const pollBadge = async () => {
    const next = settings.wechatAlert ? await readBadge(WECHAT_BUNDLE_ID) : 0;
    const rose = settings.wechatAlert && lastPolled !== null && next > lastPolled;
    const changed = next !== unreadCount;
    unreadCount = next;
    lastPolled = settings.wechatAlert ? next : null;
    if (changed) sendUnread(rose);
  };
  setInterval(pollBadge, BADGE_POLL_MS);

  // 从启动时开始算喝水间隔，刚打开就提醒不合适。
  update({ reminderState: { ...settings.reminderState, lastWaterAt: Date.now() } });
  const reminderConfig = () => ({
    ...DEFAULT_REMINDERS,
    enabled: settings.reminders.enabled,
    meals: settings.reminders.meals ?? DEFAULT_REMINDERS.meals,
    water: { ...DEFAULT_REMINDERS.water, everyMinutes: settings.reminders.waterMinutes },
  });
  setInterval(() => {
    const reminder = nextReminder(new Date(), reminderConfig(), settings.reminderState);
    if (!reminder) return;
    update({ reminderState: reminder.state });
    if (win && !win.isDestroyed()) win.webContents.send('remind', reminder.text);
  }, REMINDER_POLL_MS);

  ipcMain.handle('load-pet', () => {
    const actions = petActions();
    return {
      image: pet.image,
      layers: pet.layers ?? null,
      lines: pet.lines,
      size: petSize(),
      moveEnabled: settings.move,
      wholeAction: actions.whole ?? null,
      layerActions: actions.layers ?? {},
    };
  });
  ipcMain.handle('editor-image', () => ({
    dataUrl: imageDataUrl(editorImage),
    name: displayName(editorImage),
    visionConfigured: loadConfig(process.env, visionFiles()).configured,
  }));
  // Key 只进不出：页面可以保存，但读不回来。
  ipcMain.handle('editor-save-vision', (_event, values) => {
    saveConfig(userVisionFile(), values);
    return loadConfig(process.env, visionFiles()).configured;
  });
  // API Key 只留在主进程，页面拿不到。
  ipcMain.handle('editor-recognize', async (_event, imageUrl) => {
    try {
      return { recipe: await recognize(imageUrl, loadConfig(process.env, visionFiles())) };
    } catch (error) {
      return { error: error.message };
    }
  });
  ipcMain.handle('editor-import-whole', () => {
    switchPet(importPet(editorImage));
    editor?.close();
  });
  ipcMain.handle('editor-save', (_event, result) => {
    const id = saveComposition(result, editorImage);
    const layers = {};
    result.layers.forEach((layer, index) => {
      if (layer.action) layers[index] = layer.action;
    });
    update({ actions: { ...settings.actions, [id]: { layers } } });
    switchPet(id);
    editor?.close();
  });
  ipcMain.handle('move', (event, dx) => {
    if (!isCurrent(event)) return { hitEdge: false };
    const bounds = win.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    const { x } = clampToArea(bounds.x + dx, bounds.y, area, petSize());
    win.setBounds({ ...bounds, x });
    return { hitEdge: x !== bounds.x + dx };
  });
  ipcMain.on('pet-ready', (event, auto) => {
    if (!isCurrent(event)) return;
    autoActions = auto;
    win.showInactive();
    sendUnread(false);
  });
  ipcMain.on('set-interactive', (event, interactive) => {
    if (isCurrent(event)) win.setIgnoreMouseEvents(!interactive);
  });
  ipcMain.on('drag-start', (event) => {
    if (!isCurrent(event)) return;
    const cursor = screen.getCursorScreenPoint();
    const bounds = win.getBounds();
    dragOffset = { x: cursor.x - bounds.x, y: cursor.y - bounds.y };
  });
  ipcMain.on('drag-end', (event) => {
    if (!isCurrent(event)) return;
    dragOffset = null;
    lastCursor = null;
  });
  ipcMain.on('open-wechat', () => execFile('open', ['-b', WECHAT_BUNDLE_ID], () => {}));
  ipcMain.on('show-menu', (event, layerIndex) => {
    if (!isCurrent(event)) return;
    const actions = petActions();
    const layerAction = layerIndex === null ? null : actions.layers?.[layerIndex] ?? null;
    const setLayerAction = (action) => {
      const layers = { ...actions.layers };
      if (action) layers[layerIndex] = action;
      else delete layers[layerIndex];
      updatePetActions({ layers });
      win.webContents.send('layer-action', { index: layerIndex, action });
    };
    const setWholeAction = (action) => {
      updatePetActions({ whole: action });
      win.webContents.send('whole-action', action);
    };

    Menu.buildFromTemplate([
      {
        label: '导入图片…',
        click: async () => {
          const filePath = await pickImage();
          if (filePath) openEditor(filePath);
        },
      },
      { label: '恢复默认形象', enabled: pet.id !== DEFAULT_PET, click: () => switchPet(DEFAULT_PET) },
      { type: 'separator' },
      ...(layerIndex === null
        ? []
        : [
            {
              label: '这个部分的动作',
              submenu: [
                {
                  label: `自动（${LAYER_ACTIONS[autoActions.layer]}）`,
                  type: 'radio',
                  checked: layerAction === null,
                  click: () => setLayerAction(null),
                },
                { type: 'separator' },
                ...Object.entries(LAYER_ACTIONS).map(([action, label]) => ({
                  label,
                  type: 'radio',
                  checked: layerAction === action,
                  click: () => setLayerAction(action),
                })),
              ],
            },
          ]),
      {
        label: '整体动作',
        submenu: [
          {
            label: `自动（${WHOLE_ACTIONS[autoActions.whole]}）`,
            type: 'radio',
            checked: !actions.whole,
            click: () => setWholeAction(null),
          },
          { type: 'separator' },
          ...Object.entries(WHOLE_ACTIONS).map(([action, label]) => ({
            label,
            type: 'radio',
            checked: actions.whole === action,
            click: () => setWholeAction(action),
          })),
        ],
      },
      { type: 'separator' },
      {
        label: '大小',
        submenu: Object.entries(SIZES).map(([key, { label }]) => ({
          label,
          type: 'radio',
          checked: settings.size === key,
          click: () => {
            update({ size: key });
            rebuildWindow();
          },
        })),
      },
      {
        label: '自由活动',
        type: 'checkbox',
        checked: settings.move,
        click: (item) => {
          update({ move: item.checked });
          win.webContents.send('move-enabled', item.checked);
        },
      },
      {
        label: '到点提醒（吃饭、喝水）',
        type: 'checkbox',
        checked: settings.reminders.enabled,
        click: (item) => update({ reminders: { ...settings.reminders, enabled: item.checked } }),
      },
      {
        label: '喝水间隔',
        enabled: settings.reminders.enabled,
        submenu: Object.entries(WATER_INTERVALS).map(([minutes, label]) => ({
          label,
          type: 'radio',
          checked: settings.reminders.waterMinutes === Number(minutes),
          click: () => update({ reminders: { ...settings.reminders, waterMinutes: Number(minutes) } }),
        })),
      },
      ...(process.platform === 'darwin'
        ? [
            {
              label: '微信消息提醒',
              type: 'checkbox',
              checked: settings.wechatAlert,
              click: (item) => {
                update({ wechatAlert: item.checked });
                pollBadge();
              },
            },
          ]
        : []),
      { type: 'separator' },
      { label: `让${pet.name}下班`, click: () => app.quit() },
    ]).popup({ window: win });
  });

  win = createWindow();
});
