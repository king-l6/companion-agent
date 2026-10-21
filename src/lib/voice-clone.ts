/**
 * 本地音色克隆客户端。
 *
 * 服务端是 server/voice（FastAPI + sherpa-onnx）：
 *   POST /extract  上传音频/视频 -> 说话人分离 -> 每个角色一段参考音频 + 参考文本
 *   GET  /tts      用指定角色零样本合成
 *
 * 服务只监听 127.0.0.1:8100，音频不会离开本机。原生真机要访问电脑上的服务时，
 * 把 EXPO_PUBLIC_VOICE_SERVICE_URL 改成电脑的局域网地址即可。
 */
import { Platform } from 'react-native';

const configured = process.env.EXPO_PUBLIC_VOICE_SERVICE_URL?.trim();

export const VOICE_SERVICE_URL = (configured || 'http://127.0.0.1:8100').replace(/\/+$/, '');

export type ClonedSpeaker = {
  id: string;
  label: string;
  /** 该角色在原音视频里说话的总时长 */
  seconds: number;
  /** 参考音频时长 */
  clipSeconds: number;
  segments: number;
  /** 服务端相对路径，如 /clips/abc/0.wav */
  clipPath: string;
  /** SenseVoice 自动转写的参考文本，ZipVoice 合成时要用 */
  referenceText: string;
};

export type ExtractResult = {
  jobId: string;
  duration: number;
  speakers: ClonedSpeaker[];
};

export type VoiceServiceStatus = {
  online: boolean;
  ttsReady?: boolean;
  detail?: string;
};

function withTimeout(ms: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    done: () => clearTimeout(timer),
  };
}

async function readError(response: Response, fallback: string) {
  try {
    const data = (await response.json()) as { detail?: unknown };
    if (typeof data.detail === 'string' && data.detail.trim()) return data.detail;
  } catch {
    /* 不是 JSON 就走兜底 */
  }
  return `${fallback}（HTTP ${response.status}）`;
}

export function clipUrl(speaker: Pick<ClonedSpeaker, 'clipPath'>) {
  return `${VOICE_SERVICE_URL}${speaker.clipPath}`;
}

export function ttsUrl(text: string, speakerId: string, numSteps?: number) {
  const params = new URLSearchParams({ text, speaker: speakerId });
  if (numSteps) params.set('num_steps', String(numSteps));
  return `${VOICE_SERVICE_URL}/tts?${params.toString()}`;
}

export async function checkVoiceService(timeoutMs = 2500): Promise<VoiceServiceStatus> {
  const { signal, done } = withTimeout(timeoutMs);
  try {
    const response = await fetch(`${VOICE_SERVICE_URL}/health`, { signal });
    if (!response.ok) return { online: false, detail: `HTTP ${response.status}` };
    const data = (await response.json()) as { ttsReady?: boolean; ttsError?: string | null };
    return {
      online: true,
      ttsReady: data.ttsReady !== false,
      detail: data.ttsError ?? undefined,
    };
  } catch (error) {
    return { online: false, detail: String(error) };
  } finally {
    done();
  }
}

function fileNameFor(blob: Blob) {
  if (blob.type.includes('mp4')) return 'sample.m4a';
  if (blob.type.includes('mpeg')) return 'sample.mp3';
  if (blob.type.includes('wav')) return 'sample.wav';
  return 'sample.webm';
}

/** 上传用户录音 / 本地音视频文件，返回分离出的角色。可能耗时几十秒。 */
export async function extractSpeakers(input: {
  uri: string;
  name?: string;
  type?: string;
  timeoutMs?: number;
}): Promise<ExtractResult> {
  const form = new FormData();
  const isBlobUri =
    Platform.OS === 'web' || input.uri.startsWith('blob:') || input.uri.startsWith('data:');

  if (isBlobUri) {
    // Web 的录音和文件选择都拿到 blob URL / data URL，先换成真正的 Blob
    const blob = await (await fetch(input.uri)).blob();
    form.append('file', blob, input.name ?? fileNameFor(blob));
  } else {
    // 原生端 FormData 支持 { uri, name, type } 这种文件描述
    form.append('file', {
      uri: input.uri,
      name: input.name ?? 'sample.m4a',
      type: input.type ?? 'audio/m4a',
    } as unknown as Blob);
  }

  const { signal, done } = withTimeout(input.timeoutMs ?? 180_000);
  try {
    const response = await fetch(`${VOICE_SERVICE_URL}/extract`, {
      method: 'POST',
      body: form,
      signal,
    });
    if (!response.ok) throw new Error(await readError(response, '分离说话人失败'));

    const data = (await response.json()) as Partial<ExtractResult>;
    if (!data.jobId || !Array.isArray(data.speakers) || data.speakers.length === 0) {
      throw new Error('服务没有返回可用角色，换一段更清晰的录音试试');
    }
    return {
      jobId: data.jobId,
      duration: Number(data.duration ?? 0),
      speakers: data.speakers,
    };
  } finally {
    done();
  }
}

/** 合成为完整 WAV。Web 端配合 URL.createObjectURL 播放，原生可直接把 URL 交给播放器。 */
export async function synthesizeSpeech(
  text: string,
  speakerId: string,
  options: { numSteps?: number; timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<Blob> {
  const { signal, done } = withTimeout(options.timeoutMs ?? 120_000);
  const abort = () => {
    done();
  };
  options.signal?.addEventListener('abort', abort);
  try {
    const response = await fetch(ttsUrl(text, speakerId, options.numSteps), {
      signal: options.signal ?? signal,
    });
    if (!response.ok) throw new Error(await readError(response, '合成失败'));
    return await response.blob();
  } finally {
    done();
    options.signal?.removeEventListener('abort', abort);
  }
}
