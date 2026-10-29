const express = require('express');
const { ocr } = require('tencentcloud-sdk-nodejs-ocr');

const app = express();
app.use(express.json({ limit: '12mb' }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).send('');
  next();
});

const OcrClient = ocr.v20181119.Client;

/* =========================================================
   ⚠️ 部署提示：
   请填入你自己的腾讯云 API 密钥。
   如果你是在腾讯云 SCF 中部署，请绑定【运行角色】，
   系统会自动注入环境变量，代码会自动读取，你无需在此处硬编码。
   ========================================================= */
const credential = {
  secretId: process.env.TENCENTCLOUD_SECRETID || 'YOUR_SECRET_ID',     // 请替换为你的 SecretId
  secretKey: process.env.TENCENTCLOUD_SECRETKEY || 'YOUR_SECRET_KEY'  // 请替换为你的 SecretKey
};
if (process.env.TENCENTCLOUD_SESSIONTOKEN) {
  credential.token = process.env.TENCENTCLOUD_SESSIONTOKEN;
}

const client = new OcrClient({
  credential,
  region: process.env.TENCENTCLOUD_REGION || 'ap-guangzhou', // 默认广州，如需南京改为 ap-nanjing
  profile: {
    httpProfile: {
      endpoint: 'ocr.tencentcloudapi.com',
      reqTimeout: 15
    }
  }
});

app.post('/', async (req, res) => {
  try {
    const image = req.body && req.body.image;
    if (!image || typeof image !== 'string') {
      return res.status(400).json({ code: -1, message: '缺少图片数据' });
    }

    const base64Data = (image.includes(',') ? image.split(',').pop() : image).replace(/\s+/g, '');
    if (!base64Data || base64Data.length < 100) {
      return res.status(400).json({ code: -1, message: '图片数据无效或过短' });
    }

    const ocrRes = await client.GeneralBasicOCR({
      ImageBase64: base64Data,
      LanguageType: 'auto'
    });

    const words = [];
    for (const item of ocrRes.TextDetections || []) {
      const polygon = Array.isArray(item.Polygon) ? item.Polygon : [];
      if (!polygon.length) continue;

      const xs = polygon.map((p) => Number(p.X) || 0);
      const ys = polygon.map((p) => Number(p.Y) || 0);
      words.push({
        text: item.DetectedText || '',
        confidence: Number(item.Confidence || 0),
        x0: Math.min(...xs),
        y0: Math.min(...ys),
        x1: Math.max(...xs),
        y1: Math.max(...ys)
      });
    }

    return res.json({ code: 0, words });
  } catch (err) {
    console.error('OCR 识别异常:', err);
    return res.status(500).json({
      code: -1,
      message: (err && err.message) || 'OCR 服务异常'
    });
  }
});

const port = Number(process.env.PORT || 9000);
app.listen(port, '0.0.0.0', () => {
  console.log(`OCR Server running on port ${port}`);
});
