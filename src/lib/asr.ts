/**
 * 语音识别。
 *
 * - Web：用浏览器原生 SpeechRecognition（Chrome / Edge / Safari），真识别，不需要 Key。
 * - 原生：浏览器 API 不存在。配置 EXPO_PUBLIC_ASR_URL 后会把录音上传到自己的服务端；
 *   没配置时上层退回 mock，仅为离线演示。
 */

export type WebAsrSession = {
  promise: Promise<string>;
  stop: () => void;
};

type SpeechAlternative = { transcript?: string };
type SpeechResult = {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechAlternative;
};
type SpeechResultList = {
  length: number;
  [index: number]: SpeechResult;
};
type SpeechRecognitionEvent = { resultIndex: number; results: SpeechResultList };
type SpeechRecognitionErrorEvent = { error?: string; message?: string };

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
};

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function hasWebSpeechRecognition() {
  return getSpeechRecognitionCtor() !== null;
}

/**
 * 真·语音识别。continuous=false，说完一句浏览器会自动结束；
 * 用户也可以随时 stop() 提前结束。返回「已确认」的最终文本，空串表示没听到。
 */
export function recognizeWebSpeech(options: {
  onInterim?: (text: string) => void;
  timeoutMs?: number;
} = {}): WebAsrSession {
  const Ctor = getSpeechRecognitionCtor();
  if (!Ctor) throw new Error('unsupported');

  const recognition = new Ctor();
  recognition.lang = 'zh-CN';
  // 保持连续收听，由用户点“结束”决定断句；浏览器静音自动结束时也会把已有结果交上来
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  let finalText = '';
  let settled = false;
  let failure: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const promise = new Promise<string>((resolve, reject) => {
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (failure) {
        reject(new Error(failure));
      } else {
        resolve(finalText.trim());
      }
    };

    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const transcript = result?.[0]?.transcript ?? '';
        if (result?.isFinal) {
          finalText += transcript;
        } else {
          interim += transcript;
        }
      }
      options.onInterim?.((finalText + interim).trim());
    };

    recognition.onerror = (event) => {
      const code = event?.error || 'unknown';
      // 没听到声音、用户主动 abort 都按“空结果”处理，交给上层提示重试
      if (code === 'no-speech' || code === 'aborted') return;
      failure = code;
    };

    recognition.onend = finish;

    timer = setTimeout(
      () => {
        failure = failure || 'timeout';
        try {
          recognition.stop();
        } catch {
          /* ignore */
        }
        // 某些 WebView 不回调 onend，兜底 resolve/reject
        setTimeout(finish, 1_500);
      },
      options.timeoutMs ?? 30_000
    );

    try {
      recognition.start();
    } catch (error) {
      failure = String(error);
      finish();
    }
  });

  return {
    promise,
    stop: () => {
      try {
        recognition.stop();
      } catch {
        /* ignore */
      }
    },
  };
}

function getAsrEndpoint() {
  const endpoint = process.env.EXPO_PUBLIC_ASR_URL;
  return typeof endpoint === 'string' && endpoint.trim() ? endpoint.trim() : null;
}

/** 配了自己的 ASR 接口就优先用它：原生和 Web 都走录音上传，不依赖浏览器识别服务 */
export function hasServerAsr() {
  return getAsrEndpoint() !== null;
}

/**
 * 原生端接真 ASR：设置 EXPO_PUBLIC_ASR_URL 后，把录音以 multipart 上传，
 * 服务端返回 { "text": "..." }。没配置返回 null，由上层决定是否走 mock。
 */
export async function transcribeAudio(uri: string | null): Promise<string | null> {
  const endpoint = getAsrEndpoint();
  if (!endpoint || !uri) return null;

  const form = new FormData();
  if (typeof window !== 'undefined' && uri.startsWith('blob:')) {
    // Web 的 expo-audio 返回 blob URL，换成真正的 Blob 再上传
    const blob = await (await fetch(uri)).blob();
    form.append('file', blob, blob.type.includes('mp4') ? 'speech.m4a' : 'speech.webm');
  } else {
    form.append('file', {
      uri,
      name: 'speech.m4a',
      type: 'audio/m4a',
    } as unknown as Blob);
  }
  const model = process.env.EXPO_PUBLIC_ASR_MODEL;
  if (typeof model === 'string' && model.trim()) {
    form.append('model', model.trim());
  }

  const apiKey =
    process.env.EXPO_PUBLIC_ASR_API_KEY?.trim() || process.env.EXPO_PUBLIC_LLM_API_KEY?.trim();
  const response = await fetch(endpoint, {
    method: 'POST',
    body: form,
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined,
  });
  if (!response.ok) throw new Error(`asr_http_${response.status}`);

  const data = (await response.json()) as { text?: unknown };
  return typeof data.text === 'string' ? data.text.trim() : '';
}
