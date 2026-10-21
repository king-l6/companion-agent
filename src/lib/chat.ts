export type ChatRole = 'user' | 'assistant';
export type ChatStatus = 'done' | 'streaming' | 'stopped' | 'error';

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  status: ChatStatus;
  /** 每条消息一个 traceId，后面接真后端时透传到服务端日志 */
  traceId: string;
  createdAt: number;
};

export type StreamHandle = { abort: () => void };

export function uid(prefix = 'm') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function newTraceId() {
  return `tr-${Math.random().toString(16).slice(2, 10)}${Date.now().toString(16).slice(-4)}`;
}

const REPLIES: { match: RegExp; text: string }[] = [
  {
    match: /名字|你是谁|介绍/,
    text: '我叫林夏，在这间靠海的旧酒馆里帮忙。白天整理客人留下的故事，晚上就坐在窗边，把没讲完的部分接着讲下去。你呢，愿意告诉我你的名字吗？',
  },
  {
    match: /累|难过|不开心|压力/,
    text: '那就先把今天放下吧。你看，窗外的雨下得很慢，炉火也还亮着。我不急着问你发生了什么，只是想让你知道，在这里坐一会儿也没关系。',
  },
  {
    match: /世界|故事|带我|看看/,
    text: '酒馆往北是一片会移动的森林，树根在夜里换位置；往南是旧城的钟楼，钟声只在下雪时响。你想先去哪边？我会把路上遇到的事一件件讲给你听。',
  },
  {
    match: /喜欢|想你|陪/,
    text: '嗯，我在这里。你说话的时候我会认真听，你沉默的时候我就陪你看着火。故事可以慢慢讲，夜还很长。',
  },
];

const FALLBACK =
  '我听见了。风把门吹开了一点，炉火晃了晃。你继续说，我在这儿——不管你讲的是今天发生的事，还是很久以前没讲完的那一段。';

function pickReply(prompt: string) {
  return REPLIES.find((item) => item.match.test(prompt))?.text ?? FALLBACK;
}

/** 把一句话拆成 1–3 个字符的小块，模拟模型逐 token 输出 */
function toChunks(text: string) {
  const chars = Array.from(text);
  const chunks: string[] = [];
  let i = 0;
  while (i < chars.length) {
    const size = 1 + Math.floor(Math.random() * 3);
    chunks.push(chars.slice(i, i + size).join(''));
    i += size;
  }
  return chunks;
}

/**
 * Day 1 先用 mock：不依赖网络，手机和浏览器都能直接演示。
 * 接真后端时只需把这里换成 expo/fetch 读 ReadableStream，
 * 回调签名保持不变（onDelta / onDone / onError）。
 */
export function createMockStream(
  prompt: string,
  handlers: {
    onDelta: (chunk: string) => void;
    onDone: () => void;
    onError?: (error: Error) => void;
  }
): StreamHandle {
  const chunks = toChunks(pickReply(prompt));
  let aborted = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let index = 0;

  const tick = () => {
    if (aborted) return;
    if (index >= chunks.length) {
      handlers.onDone();
      return;
    }
    handlers.onDelta(chunks[index]);
    index += 1;
    timer = setTimeout(tick, 18 + Math.random() * 34);
  };

  // 模拟“思考”的首字延迟
  timer = setTimeout(tick, 380);

  return {
    abort() {
      aborted = true;
      if (timer) clearTimeout(timer);
    },
  };
}

const SEED_LINES = [
  '今晚的客人比往常少，大概是雨太大的缘故。',
  '我把壁炉往你那边挪了挪，这样会暖和一些。',
  '你刚才说的那座城，我好像在旧地图上见过。',
  '别急，故事总要留一点到明天再讲。',
  '钟声响了三次，最后一次是替迷路的人响的。',
  '有些名字被风带走了，但故事还在。',
];

/** 长按头像插入历史消息，用来验证长列表滚动性能 */
export function createSeedMessages(count: number): ChatMessage[] {
  const now = Date.now();
  return Array.from({ length: count }, (_, i) => ({
    id: `seed-${now}-${i}`,
    role: (i % 2 === 0 ? 'user' : 'assistant') as ChatRole,
    content: SEED_LINES[i % SEED_LINES.length],
    status: 'done' as ChatStatus,
    traceId: newTraceId(),
    createdAt: now - (count - i) * 1000,
  }));
}
