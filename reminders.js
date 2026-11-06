const DAY_MINUTES = 24 * 60;

const DEFAULT_REMINDERS = {
  enabled: true,
  // 电脑休眠错过了饭点，超过这个时间就不再补提醒。
  lateMinutes: 60,
  meals: [
    { id: 'lunch', time: '12:00', lines: ['中午啦～肚肚在咕咕叫，快去干饭！', '叮咚！午饭时间到，吃饱饱才有力气呀', '再忙也要吃饭饭，我帮你看着这里～'] },
    { id: 'dinner', time: '18:30', lines: ['天快黑啦，该吃晚饭饭咯～', '辛苦一天啦，去吃点好吃的奖励自己吧！', '晚饭时间到！先吃饭，事情等等再说嘛'] },
  ],
  water: {
    everyMinutes: 90,
    afterMealMinutes: 40,
    start: '09:00',
    end: '21:00',
    lines: ['咕噜咕噜～该喝水水啦', '我渴了，你肯定也渴了，一起喝口水吧！', '起来倒杯水，顺便伸个懒腰嘛～', '喝水时间到！要做水润润的小可爱哦'],
  },
};

function toMinutes(time) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes < DAY_MINUTES ? minutes : null;
}

function dayKey(now) {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

function pickLine(lines, random) {
  return lines[Math.floor(random() * lines.length) % lines.length];
}

// 根据当前时间决定要不要提醒。不修改 state，要提醒时返回提醒内容和新的 state。
function nextReminder(now, config, state, random = Math.random) {
  if (!config.enabled) return null;
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const nowMs = now.getTime();
  const today = dayKey(now);

  for (const meal of config.meals) {
    const start = toMinutes(meal.time);
    if (start === null || state.meals?.[meal.id] === today) continue;
    if (nowMinutes >= start && nowMinutes < start + config.lateMinutes) {
      return {
        id: meal.id,
        text: pickLine(meal.lines, random),
        state: { ...state, meals: { ...state.meals, [meal.id]: today }, lastMealAt: nowMs },
      };
    }
  }

  const { water } = config;
  const start = toMinutes(water.start);
  const end = toMinutes(water.end);
  if (start === null || end === null || nowMinutes < start || nowMinutes >= end) return null;

  const fireWater = () => ({
    id: 'water',
    text: pickLine(water.lines, random),
    state: { ...state, lastWaterAt: nowMs },
  });
  const minutesSince = (time) => (nowMs - time) / 60000;

  if (state.lastMealAt !== undefined) {
    const sinceMeal = minutesSince(state.lastMealAt);
    // 刚提醒吃饭，先不打扰。
    if (sinceMeal < water.afterMealMinutes) return null;
    // 饭后过一会儿，这顿之后还没提醒过喝水，就提醒一次。
    if (sinceMeal < water.everyMinutes && (state.lastWaterAt ?? 0) < state.lastMealAt) return fireWater();
  }
  if (state.lastWaterAt === undefined || minutesSince(state.lastWaterAt) >= water.everyMinutes) return fireWater();
  return null;
}

module.exports = { DEFAULT_REMINDERS, nextReminder, toMinutes, dayKey };
