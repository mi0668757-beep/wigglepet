// 打包前把分割模型下载到 models/，这样安装后不用联网。
const fs = require('fs');
const path = require('path');

const MODEL = 'Xenova/slimsam-77-uniform';
const FILES = ['config.json', 'preprocessor_config.json', 'onnx/vision_encoder.onnx', 'onnx/prompt_encoder_mask_decoder.onnx'];
const HOSTS = ['https://huggingface.co', 'https://hf-mirror.com'];

async function download(file) {
  const target = path.join(__dirname, '..', 'models', MODEL, file);
  if (fs.existsSync(target)) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  for (const host of HOSTS) {
    const response = await fetch(`${host}/${MODEL}/resolve/main/${file}`).catch(() => null);
    if (response?.ok) {
      fs.writeFileSync(target, Buffer.from(await response.arrayBuffer()));
      console.log(`${file} from ${host}`);
      return;
    }
  }
  throw new Error(`下载失败：${file}`);
}

(async () => {
  for (const file of FILES) await download(file);
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
