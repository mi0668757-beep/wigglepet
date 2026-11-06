const assert = require('node:assert/strict');
const { test } = require('node:test');
const { DEFAULT_REMINDERS, nextReminder, toMinutes } = require('../reminders');

const at = (time, day = 6) => {
  const [hours, minutes] = time.split(':').map(Number);
  return new Date(2026, 10, day, hours, minutes);
};
const first = () => 0;
const run = (time, state = {}, config = DEFAULT_REMINDERS, day = 6) => nextReminder(at(time, day), config, state, first);

test('解析时间，不合法的返回 null', () => {
  assert.equal(toMinutes('12:30'), 750);
  assert.equal(toMinutes('24:00'), null);
  assert.equal(toMinutes('中午'), null);
});

test('到中午提醒吃饭', () => {
  const result = run('12:00', { lastWaterAt: at('11:50').getTime() });
  assert.equal(result.id, 'lunch');
  assert.ok(result.text.includes('中午'));
});

test('一天只提醒一次午饭', () => {
  const { state } = run('12:00', { lastWaterAt: at('11:50').getTime() });
  assert.equal(run('12:05', state), null);
  assert.equal(run('12:30', state), null);
});

test('第二天又会提醒', () => {
  const { state } = run('12:00', { lastWaterAt: at('11:50').getTime() });
  assert.equal(run('12:00', { ...state, lastWaterAt: at('11:50', 7).getTime() }, DEFAULT_REMINDERS, 7).id, 'lunch');
});

test('休眠错过饭点：一小时内补提醒，太晚就算了', () => {
  const state = { lastWaterAt: at('11:50').getTime() };
  assert.equal(run('12:40', state).id, 'lunch');
  assert.equal(run('13:10', state), null);
});

test('吃饭后过一会儿提醒喝水', () => {
  const { state } = run('12:00', { lastWaterAt: at('11:00').getTime() });
  assert.equal(run('12:10', state), null);
  assert.equal(run('12:39', state), null);
  const water = run('12:40', state);
  assert.equal(water.id, 'water');
  assert.equal(run('12:41', water.state), null);
});

test('平时每隔一段时间提醒喝水', () => {
  const state = { lastWaterAt: at('09:00').getTime() };
  assert.equal(run('10:29', state), null);
  assert.equal(run('10:30', state).id, 'water');
});

test('第一次启动就在提醒时段内时，会提醒喝水', () => {
  assert.equal(run('10:00', {}).id, 'water');
});

test('深夜和清晨不提醒喝水', () => {
  assert.equal(run('23:00', {}), null);
  assert.equal(run('07:00', {}), null);
  assert.equal(run('21:00', { lastWaterAt: at('18:00').getTime() }), null);
});

test('间隔可以调整', () => {
  const config = { ...DEFAULT_REMINDERS, water: { ...DEFAULT_REMINDERS.water, everyMinutes: 30 } };
  assert.equal(run('09:30', { lastWaterAt: at('09:00').getTime() }, config).id, 'water');
  assert.equal(run('09:29', { lastWaterAt: at('09:00').getTime() }, config), null);
});

test('关闭后什么都不提醒', () => {
  assert.equal(run('12:00', {}, { ...DEFAULT_REMINDERS, enabled: false }), null);
});

test('用户自定义的时间写错时跳过，不报错', () => {
  const config = {
    ...DEFAULT_REMINDERS,
    meals: [{ id: 'bad', time: '中午', lines: ['x'] }],
    water: { ...DEFAULT_REMINDERS.water, start: 'x' },
  };
  assert.equal(run('12:00', {}, config), null);
});

test('模拟完整的一天，提醒顺序合理', () => {
  let state = {};
  const fired = [];
  for (let minutes = 8 * 60; minutes < 22 * 60; minutes += 1) {
    const now = new Date(2026, 10, 6, Math.floor(minutes / 60), minutes % 60);
    const result = nextReminder(now, DEFAULT_REMINDERS, state, first);
    if (result) {
      state = result.state;
      fired.push(`${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')} ${result.id}`);
    }
  }
  assert.deepEqual(fired, [
    '09:00 water',
    '10:30 water',
    '12:00 lunch',
    '12:40 water',
    '14:10 water',
    '15:40 water',
    '17:10 water',
    '18:30 dinner',
    '19:10 water',
    '20:40 water',
  ]);
});
