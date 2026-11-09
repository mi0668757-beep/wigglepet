const fs = require('fs');
const path = require('path');

const DEFAULT_MODEL = 'qwen3-vl-plus';
const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const REQUEST_TIMEOUT_MS = 90000;
const MAX_OBJECTS = 12;
// 模型返回的坐标归一化到这个范围。
const COORDINATE_RANGE = 1000;

const ACTION_MEANINGS = {
  breathe: '轻微起伏，适合静止或打盹的角色',
  sway: '以底部为轴左右摇摆，适合坐着的角色、植物',
  nod: '点头',
  peek: '上下探头，适合从物体后面或里面露出来的角色',
  hop: '原地蹦跳',
  float: '上下漂浮，适合悬空的物体',
  wiggle: '快速小幅抖动，适合开心或紧张的角色',
  crawl: '爬行的身体，适合趴着的角色',
  crawlHandA: '爬行时先迈的手',
  crawlHandB: '爬行时后迈的手，和 crawlHandA 交替',
  blink: '眨眼，用于单独的眼睛部分',
  wink: '单独眨一只眼',
  teeter: '摇摇欲坠，适合歪着、快要掉下来的物体',
  write: '写字或画画时的小幅来回移动，用于握笔的手和笔',
  still: '不动，适合不该动的物体',
};

// 只解析 KEY=VALUE。环境变量优先，然后按 files 的顺序，前面的文件优先。
function loadConfig(env = process.env, files = [path.join(__dirname, '.env')]) {
  const values = {};
  for (const file of [].concat(files).reverse()) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (match && match[2]) values[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  }
  const read = (key) => env[key] || values[key] || '';
  const apiKey = read('QWEN_API_KEY');
  const workspaceId = read('QWEN_WORKSPACE_ID');
  const baseUrl =
    read('QWEN_BASE_URL') ||
    (workspaceId ? `https://${workspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` : DEFAULT_BASE_URL);
  return { apiKey, baseUrl, model: read('QWEN_MODEL') || DEFAULT_MODEL, configured: Boolean(apiKey) };
}

// 界面里填的 Key 存成同样的格式，文件只有当前用户能读。
function saveConfig(file, { apiKey, workspaceId }) {
  const clean = (value) => String(value ?? '').replace(/[\r\n]/g, '').trim();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `QWEN_API_KEY=${clean(apiKey)}\nQWEN_WORKSPACE_ID=${clean(workspaceId)}\n`, { mode: 0o600 });
}

function buildPrompt(actions = ACTION_MEANINGS) {
  const actionList = Object.entries(actions)
    .map(([name, meaning]) => `- ${name}：${meaning}`)
    .join('\n');
  return `你在帮用户把一张卡通图做成桌面宠物。整张图的构图保持不动，只有部分对象做动作。
请先看懂画面主题和每个对象的姿势，再根据姿势决定动作，不要给所有对象配相同的动作。

判断方法：
- 动作要符合情境：趴着且手撑在地上的角色在爬，身体用 crawl，两只手分别用 crawlHandA 和 crawlHandB；从袋子或箱子里露头的可以探头。
- teeter 只用于明显歪斜、看起来快要掉下来的物体。放得好好的杯子、蛋糕、正常戴着的帽子都不要用。
- 角色手里拿着东西时，这个东西要单独列出来并跟随那只手。比如在写字或画画：握笔的手和笔都用 write，笔跟随手。
- 放在桌上或地上的大物体（书、本子、桌子）用 still，小摆件（杯子、蛋糕）用 still 或 breathe。
- 戴眼镜的角色，眼睛的 bbox 和 points 只对准瞳孔或黑眼珠，不要包括镜片和镜框。
- 拿不准时用 breathe 或 still，宁可少动，不要乱动。
- 物体搭在别的物体上时要设跟随：坐在纸箱上的猫跟随纸箱，戴在头上的东西跟随角色。
- 主要角色的眼睛和手如果清晰可见，要单独列为对象，并跟随身体。
- 只有列出来的对象才会出现在桌宠上，其余的都会被去掉。
- 背景、地面、地毯、桌面、闪光和星星这类装饰不要列。
- 和主体在一起的物体即使不动也要列，比如角色身后的书、藏着猫的袋子、手边的杯子，动作用 still。否则去掉它们后，主体会悬空或缺一块。
- 只列完整的物体和角色的眼睛、手。不要把物体上的细节（阴影、折痕、缝线、花纹、水印、文字）列为对象。
- 主要角色要作为一个完整的身体列出来，不要只列头部。
- 被跟随的对象必须排在跟随它的对象前面。
- 少而准：通常 3 到 8 个对象就够，不要超过 ${MAX_OBJECTS} 个。手臂、腿、帽子、头发不要拆开，只有主要角色的眼睛、撑地或拿东西的手才单独列出。
- 黑白线稿或细节很密的图更难抠，只列最主要的 2 到 4 个完整对象。

可选动作：
${actionList}

坐标用归一化值，图片左上角是 (0,0)，右下角是 (999,999)。
- bbox：对象的边界框 [x1, y1, x2, y2]。
- points：1 到 4 个一定落在这个对象上的点 [x, y]，花纹多的对象要多给几个，分散在不同位置。
- exclude：0 到 4 个紧贴这个对象、但不属于它的点。对象和别的东西贴在一起时一定要给，比如猫贴着袋子时，在袋子上给一个点。

只输出 JSON，格式如下：
{
  "theme": "一句话描述画面主题",
  "objects": [
    {
      "name": "对象名",
      "pose": "它的姿势或状态",
      "action": "可选动作之一",
      "follows": null,
      "bbox": [0, 0, 999, 999],
      "points": [[500, 500]],
      "exclude": []
    }
  ]
}
follows 是被跟随对象在 objects 里的序号（从 0 开始），不跟随时为 null。`;
}

const isPair = (value) =>
  Array.isArray(value) && value.length === 2 && value.every((n) => Number.isFinite(n));

const toFraction = (value) => Math.max(0, Math.min(1, value / (COORDINATE_RANGE - 1)));

function normalizePoints(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(isPair).map(([x, y]) => ({ x: toFraction(x), y: toFraction(y) }));
}

function normalizeBox(value) {
  if (!Array.isArray(value) || value.length !== 4 || !value.every((n) => Number.isFinite(n))) return null;
  const xs = [toFraction(value[0]), toFraction(value[2])].sort((a, b) => a - b);
  const ys = [toFraction(value[1]), toFraction(value[3])].sort((a, b) => a - b);
  if (xs[0] === xs[1] || ys[0] === ys[1]) return null;
  return { left: xs[0], right: xs[1], top: ys[0], bottom: ys[1] };
}

// 模型的回答不可全信：图片输入时格式不受约束，字段可能缺失、越界或互相矛盾。
// 能修的就修，修不了的对象直接丢弃，一个可用对象都没有才算失败。
function parseRecipe(text, actions = ACTION_MEANINGS) {
  const cleaned = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let data;
  try {
    data = JSON.parse(cleaned);
  } catch {
    throw new Error('模型返回的不是有效的 JSON');
  }
  if (!Array.isArray(data?.objects)) throw new Error('模型返回的结果里没有对象列表');

  const kept = [];
  const newIndex = new Map();
  data.objects.slice(0, MAX_OBJECTS).forEach((object, index) => {
    const points = normalizePoints(object?.points).slice(0, 4);
    const box = normalizeBox(object?.bbox);
    if (!points.length && !box) return;
    if (!points.length) points.push({ x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 });
    newIndex.set(index, kept.length);
    kept.push({
      name: String(object.name ?? `对象 ${kept.length + 1}`).slice(0, 20),
      pose: String(object.pose ?? '').slice(0, 60),
      action: object.action in actions ? object.action : null,
      box,
      points,
      exclude: normalizePoints(object.exclude).slice(0, 4),
      rawFollows: object.follows,
    });
  });
  if (!kept.length) throw new Error('模型没有返回可用的对象');

  // 跟随只能指向前面的对象，这样不会成环，被跟随的也一定先画。
  const objects = kept.map(({ rawFollows, ...object }, index) => {
    const target = Number.isInteger(rawFollows) ? newIndex.get(rawFollows) : undefined;
    return { ...object, follows: target !== undefined && target < index ? target : null };
  });
  // 手在爬，身体也应该在爬。模型有时判断不一致，这里统一。
  for (const object of objects) {
    const isHand = object.action === 'crawlHandA' || object.action === 'crawlHandB';
    if (isHand && object.follows !== null && 'crawl' in actions) objects[object.follows].action = 'crawl';
  }
  return { theme: String(data.theme ?? '').slice(0, 120), objects };
}

async function recognize(imageDataUrl, config, fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS, actions = ACTION_MEANINGS) {
  let response;
  try {
    response = await fetchImpl(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        // 视觉模型只有在非思考模式下才支持结构化输出。
        enable_thinking: false,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: imageDataUrl } },
              { type: 'text', text: buildPrompt(actions) },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error.name === 'TimeoutError') throw new Error('识别超时，请稍后再试');
    throw new Error('连接模型服务失败，请检查网络');
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error('API Key 或 WorkspaceId 无效，请检查 .env');
  }
  if (response.status === 429) throw new Error('调用太频繁或额度不足，请稍后再试');
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    if (/workspace/i.test(detail?.message ?? '')) {
      throw new Error('WorkspaceId 无效，请到百炼控制台重新复制，并检查 .env');
    }
    throw new Error(`模型服务返回错误（${response.status}）`);
  }

  const body = await response.json();
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('模型服务返回的内容为空');
  return parseRecipe(content, actions);
}

module.exports = { loadConfig, saveConfig, buildPrompt, parseRecipe, recognize, ACTION_MEANINGS };
