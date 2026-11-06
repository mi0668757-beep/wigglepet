const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const { loadConfig, saveConfig, buildPrompt, parseRecipe, recognize, ACTION_MEANINGS } = require('../vision');

const noFile = path.join(os.tmpdir(), 'desktop-pet-no-such-env');

function recipe(objects, extra = {}) {
  return JSON.stringify({ theme: '猫和纸箱', objects, ...extra });
}

const cat = { name: '猫', pose: '坐着', action: 'sway', follows: null, bbox: [100, 100, 300, 300], points: [[200, 200]], exclude: [] };

test('没有配置时不可用，不会报错', () => {
  const config = loadConfig({}, noFile);
  assert.equal(config.configured, false);
  assert.equal(config.model, 'qwen3-vl-plus');
});

test('从 .env 读取配置，按 WorkspaceId 拼出北京地域地址', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pet-')), '.env');
  fs.writeFileSync(file, '# 注释\nQWEN_API_KEY="sk-test"\nQWEN_WORKSPACE_ID=ws1\n\n');
  const config = loadConfig({}, file);
  assert.equal(config.apiKey, 'sk-test');
  assert.equal(config.baseUrl, 'https://ws1.cn-beijing.maas.aliyuncs.com/compatible-mode/v1');
  assert.equal(config.configured, true);
});

test('环境变量优先于 .env，也可以换模型和地址', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pet-')), '.env');
  fs.writeFileSync(file, 'QWEN_API_KEY=from-file\nQWEN_WORKSPACE_ID=ws1\n');
  const config = loadConfig({ QWEN_API_KEY: 'from-env', QWEN_BASE_URL: 'http://localhost:1/v1', QWEN_MODEL: 'other' }, file);
  assert.equal(config.apiKey, 'from-env');
  assert.equal(config.baseUrl, 'http://localhost:1/v1');
  assert.equal(config.model, 'other');
});

test('只填 Key 也能用，走默认地址', () => {
  const config = loadConfig({ QWEN_API_KEY: 'k' }, noFile);
  assert.equal(config.configured, true);
  assert.equal(config.baseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
});

test('多个配置来源时，前面的优先，后面的补缺，空值不覆盖', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-'));
  const user = path.join(dir, 'user.env');
  const bundled = path.join(dir, 'bundled.env');
  fs.writeFileSync(user, 'QWEN_API_KEY=mine\nQWEN_WORKSPACE_ID=\n');
  fs.writeFileSync(bundled, 'QWEN_API_KEY=team\nQWEN_MODEL=team-model\n');
  const config = loadConfig({}, [user, bundled]);
  assert.equal(config.apiKey, 'mine');
  assert.equal(config.model, 'team-model');
});

test('保存 Key 后读得回来，换行不会注入其他配置，文件只有自己能读', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pet-')), 'sub', 'vision.env');
  saveConfig(file, { apiKey: ' sk-abc\nQWEN_BASE_URL=http://evil ', workspaceId: '' });
  const config = loadConfig({}, file);
  assert.ok(config.apiKey.startsWith('sk-abc'));
  assert.ok(!config.baseUrl.includes('evil'));
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('提示词列出所有动作和坐标规则', () => {
  const prompt = buildPrompt();
  for (const action of Object.keys(ACTION_MEANINGS)) assert.ok(prompt.includes(action), action);
  assert.ok(prompt.includes('999'));
  assert.ok(prompt.includes('JSON'));
});

test('正常结果被转换成 0 到 1 的坐标', () => {
  const { theme, objects } = parseRecipe(recipe([cat]));
  assert.equal(theme, '猫和纸箱');
  assert.equal(objects[0].action, 'sway');
  assert.ok(Math.abs(objects[0].points[0].x - 200 / 999) < 1e-9);
  assert.ok(Math.abs(objects[0].box.right - 300 / 999) < 1e-9);
});

test('模型用代码块包裹 JSON 时也能解析', () => {
  assert.equal(parseRecipe('```json\n' + recipe([cat]) + '\n```').objects.length, 1);
});

test('不是 JSON 或没有对象列表时明确报错', () => {
  assert.throws(() => parseRecipe('抱歉，我看不清'), /不是有效的 JSON/);
  assert.throws(() => parseRecipe('{"theme":"x"}'), /没有对象列表/);
  assert.throws(() => parseRecipe('{"objects":[{"name":"空"}]}'), /没有返回可用的对象/);
});

test('不认识的动作变成自动，越界坐标被夹回范围内', () => {
  const { objects } = parseRecipe(recipe([{ ...cat, action: 'fly_to_moon', points: [[5000, -20]] }]));
  assert.equal(objects[0].action, null);
  assert.deepEqual(objects[0].points[0], { x: 1, y: 0 });
});

test('缺点时用边界框中心，点和框都没有的对象被丢弃，跟随序号随之修正', () => {
  const { objects } = parseRecipe(
    recipe([
      cat,
      { name: '坏的', action: 'sway' },
      { ...cat, name: '只有框', points: [] },
      { ...cat, name: '跟随只有框', follows: 2 },
    ]),
  );
  assert.deepEqual(objects.map((o) => o.name), ['猫', '只有框', '跟随只有框']);
  assert.ok(Math.abs(objects[1].points[0].x - 200 / 999) < 1e-9);
  assert.equal(objects[2].follows, 1);
});

test('反向的边界框会被摆正，面积为零的不算框', () => {
  const { objects } = parseRecipe(recipe([{ ...cat, bbox: [300, 300, 100, 100] }, { ...cat, bbox: [100, 100, 100, 300] }]));
  assert.ok(objects[0].box.left < objects[0].box.right);
  assert.equal(objects[1].box, null);
});

test('跟随自己、后面的对象或被丢弃的对象都视为不跟随', () => {
  const { objects } = parseRecipe(
    recipe([
      { ...cat, follows: 1 },
      { ...cat, follows: 1 },
      { ...cat, follows: 99 },
      { ...cat, follows: '0' },
    ]),
  );
  assert.deepEqual(objects.map((o) => o.follows), [null, null, null, null]);
});

test('手在爬时，被跟随的身体也改成爬', () => {
  const { objects } = parseRecipe(
    recipe([
      { ...cat, name: '女孩', action: 'breathe' },
      { ...cat, name: '手', action: 'crawlHandA', follows: 0 },
      { ...cat, name: '别的猫', action: 'breathe' },
    ]),
  );
  assert.deepEqual(objects.map((o) => o.action), ['crawl', 'crawlHandA', 'breathe']);
});

test('手没有跟随任何对象时不影响其他对象', () => {
  const { objects } = parseRecipe(recipe([{ ...cat, action: 'breathe' }, { ...cat, action: 'crawlHandA' }]));
  assert.equal(objects[0].action, 'breathe');
});

test('最多保留 12 个对象', () => {
  assert.equal(parseRecipe(recipe(Array.from({ length: 30 }, () => cat))).objects.length, 12);
});

const config = { apiKey: 'sk-secret', baseUrl: 'https://example.test/v1/', model: 'qwen3-vl-plus' };
const reply = (content, status = 200) => async () =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status });

test('请求带上模型、JSON 模式、非思考模式和图片', async () => {
  let sent;
  await recognize('data:image/jpeg;base64,AAAA', config, async (url, options) => {
    sent = { url, options, body: JSON.parse(options.body) };
    return reply(recipe([cat]))();
  });
  assert.equal(sent.url, 'https://example.test/v1/chat/completions');
  assert.equal(sent.options.headers.Authorization, 'Bearer sk-secret');
  assert.equal(sent.body.model, 'qwen3-vl-plus');
  assert.equal(sent.body.enable_thinking, false);
  assert.equal(sent.body.response_format.type, 'json_object');
  assert.equal(sent.body.max_tokens, undefined);
  assert.equal(sent.body.messages[0].content[0].image_url.url, 'data:image/jpeg;base64,AAAA');
});

test('各种失败都给出能看懂的提示，且不泄露 Key', async () => {
  const cases = [
    [async () => new Response('{}', { status: 401 }), /API Key/],
    [async () => new Response('{}', { status: 429 }), /频繁或额度/],
    [async () => new Response('{}', { status: 500 }), /500/],
    [async () => new Response('{"message":"Workspace endpoint is invalid."}', { status: 400 }), /WorkspaceId/],
    [async () => new Response('not json', { status: 400 }), /400/],
    [async () => new Response('{"choices":[]}', { status: 200 }), /内容为空/],
    [reply('不是 JSON'), /不是有效的 JSON/],
    [async () => { throw new TypeError('fetch failed'); }, /连接模型服务失败/],
    [async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; }, /超时/],
  ];
  for (const [fetchImpl, expected] of cases) {
    await assert.rejects(recognize('data:', config, fetchImpl), (error) => {
      assert.match(error.message, expected);
      assert.ok(!error.message.includes('sk-secret'));
      return true;
    });
  }
});
