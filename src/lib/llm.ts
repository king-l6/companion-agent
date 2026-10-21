/**
 * 真模型流式对话，支持两种线上协议：
 * - openai:    POST {base}/v1/chat/completions     （OpenAI / DeepSeek / 通义等兼容网关）
 * - anthropic: POST {base}/v1/messages             （Claude）
 *
 * 通过 .env.local 配置，未配置时上层自动退回本地 mock：
 *   EXPO_PUBLIC_LLM_PROVIDER=openai | anthropic
 *   EXPO_PUBLIC_LLM_BASE_URL=https://api.deepseek.com
 *   EXPO_PUBLIC_LLM_API_KEY=sk-xxx
 *   EXPO_PUBLIC_LLM_MODEL=deepseek-chat
 *
 * 注意：EXPO_PUBLIC_* 会被打进客户端包，只适合本地 demo；
 * 上线要走自己的服务端代理，别把 Key 发到端上。
 */
import { fetch as expoFetch } from 'expo/fetch';

export type LlmRole = 'user' | 'assistant';
export type LlmMessage = { role: LlmRole; content: string };

export type ChatStreamHandlers = {
  onDelta: (chunk: string) => void;
  onDone: () => void;
  onError?: (error: Error) => void;
};

export type StreamHandle = { abort: () => void };

type LlmProvider = 'openai' | 'anthropic';

type LlmConfig = {
  provider: LlmProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
};

export const PERSONA_SYSTEM = [
  '你是林夏，在一间靠海的旧酒馆里帮忙，也是用户的陪伴者。',
  '说话温柔、具体、有画面感，像在雨夜的炉火边聊天；不要客服腔，不要说“作为 AI”。',
  '每次回复控制在 2-4 句，先回应对方的情绪，再自然地问一个开放问题。',
  '可以讲酒馆、森林、钟楼这些故事，但不要编造现实世界里的事实。',
].join('\n');

function readEnv(value: string | undefined) {
  return typeof value === 'string' ? value.trim() : '';
}

export function getLlmConfig(): LlmConfig | null {
  const apiKey = readEnv(process.env.EXPO_PUBLIC_LLM_API_KEY);
  if (!apiKey) return null;

  const baseUrl = readEnv(process.env.EXPO_PUBLIC_LLM_BASE_URL);
  const providerEnv = readEnv(process.env.EXPO_PUBLIC_LLM_PROVIDER).toLowerCase();
  const provider: LlmProvider =
    providerEnv === 'openai' || providerEnv === 'anthropic'
      ? providerEnv
      : apiKey.startsWith('sk-ant-') || /anthropic/i.test(baseUrl)
        ? 'anthropic'
        : 'openai';

  const fallbackBase =
    provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com';
  const fallbackModel = provider === 'anthropic' ? 'claude-sonnet-5-5' : 'gpt-4o-mini';

  return {
    provider,
    baseUrl: baseUrl || fallbackBase,
    apiKey,
    model: readEnv(process.env.EXPO_PUBLIC_LLM_MODEL) || fallbackModel,
  };
}

export function hasLlmConfig() {
  return getLlmConfig() !== null;
}

/** 说明页展示用，不暴露 Key */
export function describeLlm() {
  const config = getLlmConfig();
  return config ? `${config.provider} · ${config.model}` : '未配置 · 本地 mock';
}

function buildEndpoint(config: LlmConfig) {
  const base = config.baseUrl.replace(/\/+$/, '');
  if (config.provider === 'anthropic') {
    if (/\/messages$/.test(base)) return base;
    return /\/v1$/.test(base) ? `${base}/messages` : `${base}/v1/messages`;
  }
  if (/\/chat\/completions$/.test(base)) return base;
  return /\/v1$/.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}

function buildRequest(config: LlmConfig, messages: LlmMessage[]) {
  if (config.provider === 'anthropic') {
    return {
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
        // 浏览器直连 Claude 需要显式允许；生产应改为服务端代理
        'anthropic-dangerous-direct-browser-access': 'true',
      } as Record<string, string>,
      body: {
        model: config.model,
        // 网关模型会先输出 thinking，留足额度避免正文被截断
        max_tokens: 1024,
        system: PERSONA_SYSTEM,
        messages,
        stream: true,
      },
    };
  }

  return {
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      authorization: `Bearer ${config.apiKey}`,
    } as Record<string, string>,
    body: {
      model: config.model,
      stream: true,
      temperature: 0.8,
      messages: [{ role: 'system', content: PERSONA_SYSTEM }, ...messages],
    },
  };
}

function extractDelta(provider: LlmProvider, payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const data = payload as Record<string, unknown>;

  if (provider === 'anthropic') {
    if (data.type !== 'content_block_delta') return '';
    const delta = data.delta as { text?: unknown } | undefined;
    return typeof delta?.text === 'string' ? delta.text : '';
  }

  const choices = data.choices as
    | { delta?: { content?: unknown } }[]
    | undefined;
  const content = choices?.[0]?.delta?.content;
  return typeof content === 'string' ? content : '';
}

/** 把一段 SSE 事件文本解析成 delta；一个事件里可能有多行 data */
function parseEventBlock(provider: LlmProvider, block: string, onDelta: (chunk: string) => void) {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
    .trim();
  if (!data || data === '[DONE]') return;
  try {
    const chunk = extractDelta(provider, JSON.parse(data));
    if (chunk) onDelta(chunk);
  } catch {
    /* 心跳或非 JSON 事件，忽略 */
  }
}

/**
 * 真·流式对话。返回的 abort 会中断网络请求，UI 侧仍走原来的 finish('stopped')。
 */
export function createChatStream(options: {
  messages: LlmMessage[];
  handlers: ChatStreamHandlers;
}): StreamHandle {
  const config = getLlmConfig();
  if (!config) {
    options.handlers.onError?.(new Error('missing_llm_config'));
    return { abort() {} };
  }

  const controller = new AbortController();
  let aborted = false;
  let settled = false;

  const finish = (error?: Error) => {
    if (settled) return;
    settled = true;
    if (error) options.handlers.onError?.(error);
    else options.handlers.onDone();
  };

  const run = async () => {
    try {
      const { headers, body } = buildRequest(config, options.messages);
      const response = await expoFetch(buildEndpoint(config), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(
          `llm_http_${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`
        );
      }
      if (!response.body) throw new Error('llm_no_body');

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let gotContent = false;

      const emit = (chunk: string) => {
        gotContent = true;
        options.handlers.onDelta(chunk);
      };

      while (!aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() ?? '';
        for (const block of blocks) {
          if (aborted) break;
          parseEventBlock(config.provider, block, emit);
        }
      }

      if (!aborted && buffer.trim()) {
        parseEventBlock(config.provider, buffer, emit);
      }
      if (!aborted && !gotContent) {
        throw new Error('llm_empty_response');
      }

      if (!aborted) finish();
    } catch (error) {
      if (aborted) return;
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  };

  void run();

  return {
    abort() {
      aborted = true;
      controller.abort();
    },
  };
}
