const { execFile } = require('child_process');

const WECHAT_BUNDLE_ID = 'com.tencent.xinWeChat';

// 只读系统记录的 Dock 角标，不接触微信进程，也拿不到消息内容。
function parseBadge(output) {
  const match = /"label"="([^"]*)"/.exec(output);
  if (!match || !match[1]) return 0;
  const count = Number.parseInt(match[1], 10);
  return Number.isNaN(count) ? 1 : count;
}

function readBadge(bundleId) {
  return new Promise((resolve) => {
    execFile('lsappinfo', ['info', '-only', 'StatusLabel', '-app', bundleId], (error, stdout) => {
      resolve(error ? 0 : parseBadge(stdout));
    });
  });
}

module.exports = { WECHAT_BUNDLE_ID, parseBadge, readBadge };
