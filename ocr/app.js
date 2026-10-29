const express = require('express');
const { ocr } = require('tencentcloud-sdk-nodejs-ocr');

const app = express();
// 允许接收最大 12MB 的 JSON 数据
app.use(express.json({ limit: '12mb' }));

// 跨域配置
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).send('');
  next();
});

const OcrClient = ocr.v20181119.Client;

/* =========================================================
   ⚠️ 部署前必读：
   请在此处填入你自己的腾讯云 API 密钥。
   （如果你在腾讯云 SCF 中绑定了运行角色，通常不需要手动填这里，
     系统会自动注入。但为了开源通用性，这里保留了直接填写的占位符）
   ========================================================= */
const credential = {
  secretId: 'YOUR_TENCENTCLOUD_SECRET_ID',     // 替换为你的 SecretId
  secretKey: 'YOUR_TENCENTCLOUD_SECRET_KEY',   // 替换为你的 SecretKey
  
  // 如果你使用的是临时密钥（如 SCF 运行角色），请取消下面这行的注释并填入 Token
  // token: 'YOUR_TENCENTCLOUD_SESSION_TOKEN' 
};

const client = new OcrClient({
  credential,
  // 地域配置：默认广州，请根据你的实际部署地域修改（如 ap-nanjing）
  region: 'ap-guangzhou', 
  profile: {
    httpProfile: {
      endpoint: 'ocr.tencentcloudapi.com',
      reqTimeout: 15
    }
  }
});

// 处理 OCR 识别请求
app.post('/', async (req, res) => {
  try {
    const image = req.body && req.body.image;
    if (!image || typeof image !== 'string') {
      return res.status(400).json({ code: -1, message: '缺少图片数据' });
    }

    // 去除 Base64 的头部前缀
    const base64Data = (image.includes(',') ? image.split(',').pop() : image).replace(/\s+/g, '');
    if (!base64Data || base64Data.length < 100) {
      return res.status(400).json({ code: -1, message: '图片数据无效或过短' });
    }

    // 调用腾讯云通用印刷体识别接口
    const ocrRes = await client.GeneralBasicOCR({
      ImageBase64: base64Data,
      LanguageType: 'auto'
    });

    const words = [];
    // 提取文字内容和坐标框
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

// 启动服务
const port = 9000;
app.listen(port, '0.0.0.0', () => {
  console.log(`OCR Server running on port ${port}`);
});