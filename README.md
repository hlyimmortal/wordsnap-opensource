# WordSnap - 拍照识词记忆检测 📷

一个专为纸质单词书（如红宝书）设计的个人复习工具。通过拍照 OCR 识别、中英切换、词典弹窗、画圈标红等功能，实现高效的多轮记忆检测。

> 💡 **提示：** 本项目分为前端静态页面 + 腾讯云 SCF 后端。本仓库**不包含**真实的云函数接口，请按下方教程部署你自己的后端。

## ✨ 功能亮点
- **拍照识别**：自动按列提取单词，还原纸质表单排版。
- **极速查词**：单击中英切换，双击查看详情（音标、释义、例句）。
- **模式分离**：独创“标记模式”，彻底解决平板/手机上滑动与画圈手势冲突。
- **记忆检测**：画圈标记不熟的词，点击“完成本轮”，下一轮只保留错词，直到完全记住。

## 🚀 部署教程

### 1. 准备前端
克隆本仓库后，打开 `web/new.js`，将顶部的接口替换为你自己部署的地址：

```javascript
const OCR_FN_URL = 'YOUR_OCR_FUNCTION_URL_HERE';     
const TRANS_FN_URL = 'YOUR_TRANS_FUNCTION_URL_HERE'; 
```

用本地服务器运行（如 `python -m http.server 8080`），或部署到腾讯云 CloudBase / Vercel。

### 2. 部署后端 (腾讯云 SCF)
- **OCR 识别 (`ocr` 文件夹)**：使用 `app.js` 和 `package.json`。运行环境为 **Node.js 18**。启动脚本参考 `scf_bootstrap`。
- **翻译服务 (`translate` 文件夹)**：使用 `index.py` 和 `requirements.txt`。运行环境为 **Python 3.10**。启动脚本参考 `scf_bootstrap`。
  - **📦 词库说明**：本仓库已内置精简版词库 `stardict.db`（约 7MB）。如果你需要更完整的词库，可以前往 [ECDICT 官方仓库](https://github.com/skywind3000/ECDICT) 下载后替换同名文件。

## 🛡️ 安全建议
部署完成后，强烈建议在腾讯云函数控制台的「函数 URL」设置中，将 CORS 的 `Allow-Origin` 从 `*` 改为你的前端域名，防止接口被恶意盗刷。

## 📄 License
MIT License
