# Companion Demo

AI 陪伴叙事 App 的客户端切片，用 Expo / React Native 实现，目标是把「流式对话 + 语音打断 + 订阅」这条主链路跑通。

配置模型 Key 后走**真实模型流式对话**；没配置时自动回退本地 mock，保证离线也能演示。Web 端语音输入用浏览器原生识别，是真的转写。

## 已实现

- 流式对话：真模型 SSE（OpenAI 兼容 / Claude），UI 每 50ms 批量刷新，生成中可停止；未配置 Key 时自动回退 mock
- 长列表：FlashList 渲染；长按左上角头像插入 500 条历史消息做压测
- TTS 朗读：回复完成后自动朗读；用户发消息、开订阅、关声音时立刻打断（barge-in）；点任意 AI 气泡可重读
- 音色可换：「温柔 / 活泼 / 沉稳」三种语速音高预设 + 本机系统中文音色，说明页可试听，选择持久化
- 克隆音色：上传音频/视频或直接录音，本机自动分离说话人、转写参考文本，选中角色后回复用克隆声音逐句朗读（音视频不出本机）
- 语音输入：Web 用浏览器原生识别，边说边出字，结束后直接发送；空结果/太短可重试。原生端可配 `EXPO_PUBLIC_ASR_URL`，未配置时回退 mock
- 订阅：三档套餐、mock 支付、恢复购买、免费 5 条门控
- 埋点：`paywall_view / plan_select / purchase_start / purchase_success / chat_send / tts_start / voice_*`，说明页可查看
- 本地会话：AsyncStorage 持久化，冷启动恢复消息、会员、声音开关和音色设置
- traceId：每条消息一个，接真后端时透传到服务端日志
- 深浅色主题跟随系统；Web 端 SPA（`output: "single"`，关掉 SSR，避免 RN Web 首屏 hydration 抖动）

## 跑起来

```bash
cp .env.example .env.local   # 填模型 Key；不填就用本地 mock
npm install
npx expo start        # 扫码用 Expo Go 打开
npx expo start --web  # 浏览器预览
```

## 90 秒演示

1. 点「你是谁？」或自己输入，看回复逐字出现并自动朗读
2. 朗读时立刻发下一条，观察声音被打断
3. 点麦克风说一句话，文字边说边出现；点结束直接发出，没听清会提示重试
4. 点顶部「会员 · 剩 5」，选月卡开通，再刷新页面确认消息和会员都还在
5. 打开「说明」页换声音风格/音色并试听；在「克隆音色」里上传一段采访/对白或录 10–30 秒，选一个角色后回聊天页听克隆声音，看埋点漏斗和实现清单
6. 长按左上角头像，插入 500 条消息，快速滚动看列表

## 代码位置

| 文件 | 作用 |
|------|------|
| `src/app/index.tsx` | 对话页：流式、停止、TTS/打断、录音、门控、持久化 |
| `src/lib/chat.ts` | 消息类型、mock 流、traceId、种子消息 |
| `src/lib/llm.ts` | 真模型流式请求：OpenAI 兼容 / Claude SSE、人设、中止 |
| `src/lib/asr.ts` | Web 浏览器语音识别 / 原生端 ASR 上传 |
| `src/lib/storage.ts` | 消息 / 权益 / 声音开关 / 音色设置的本地持久化 |
| `src/lib/analytics.ts` | 埋点事件与漏斗汇总 |
| `src/lib/speech.ts` | 系统 TTS 封装：音色枚举、语速/音高预设，一次只允许一句在说 |
| `src/lib/voice-clone.ts` | 本地音色服务客户端：上传提取说话人、试听/合成 |
| `server/voice/` | FastAPI + sherpa-onnx：ffmpeg 抽音轨、说话人分离、SenseVoice 转写、ZipVoice 克隆 |
| `src/components/chat-bubble.tsx` | 气泡渲染（memo），点击重读 |
| `src/components/paywall-sheet.tsx` | 订阅页、mock 支付、恢复购买 |
| `src/app/explore.tsx` | 说明页：会员状态、埋点调试、演示步骤 |

模型请求在 `src/lib/llm.ts`：OpenAI 兼容网关和 Claude 的 SSE 都支持，配置项见 `.env.example`。

### 公司内网网关（Anthropic 兼容）

推荐走本地代理，真实 Key 不打进客户端包：

```bash
cp .env.proxy.example .env.proxy   # 填入 ANTHROPIC_API_KEY
npm run llm-proxy
```

`.env.proxy` 默认指向 `https://llmapi.bilibili.co`、`Bearer` 鉴权、`deepseek-v4-flash`；`ANTHROPIC_AUTH_STYLE` 可切换 `x-api-key` / `api-key`。客户端 `.env.local` 指向 `http://127.0.0.1:8099`，Key 填任意占位值即可。

`EXPO_PUBLIC_*` 直连方式会打进客户端包，只适合临时调试；上线要把 Key 收到服务端，客户端只带 traceId 和会话 ID。

## 本地克隆音色

说明页的「克隆音色」支持上传音频/视频或直接录音（10–30 秒效果最好），自动分离出多个说话人供选择。所有处理都在本机：

```bash
# 首次：装依赖 + 下模型（约 500MB）
uv venv --python 3.11 server/voice/.venv
uv pip install --python server/voice/.venv/bin/python -r server/voice/requirements.txt
bash server/voice/scripts/download_models.sh

# 启动本地音色服务（另开一个终端）
npm run voice-service
```

技术栈：ffmpeg 抽音轨 → sherpa-onnx pyannote 分段 + CAM++ 声纹聚类 → 每个角色切 3–15 秒参考音频 → SenseVoice 自动转写参考文本 → ZipVoice 零样本克隆（24kHz）。服务只监听 `127.0.0.1:8100`，音频不出本机；客户端可用 `EXPO_PUBLIC_VOICE_SERVICE_URL` 改地址。首次 `/extract` 会懒加载分离模型，慢几秒。

克隆失败或服务没启动时，聊天会自动回退系统 TTS，并提示原因。

## 配套材料

- 多仓编排与自动验收：[`../inplay-multirepo/`](../inplay-multirepo/)
- Go SSE 网关（幂等/重试）：[`../go-gateway/`](../go-gateway/)
- 二面讲法与演示脚本：[`../二面准备.md`](../二面准备.md)

## 下一步

- 模型 Key 收到服务端代理，按 traceId 落结构化日志
- 原生端接真 ASR；TTS 首包流式返回（当前按句合成，首句仍需等待）
- 克隆音色质量：用更长的干净参考音频、或换更强的零样本模型
- 推送、角色剧情、积分消耗
