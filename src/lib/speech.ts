import { Platform } from 'react-native';
import * as Speech from 'expo-speech';

export type SpeakHandlers = {
  onStart?: () => void;
  onDone?: () => void;
  onStopped?: () => void;
  onError?: () => void;
};

export type VoicePreset = 'gentle' | 'lively' | 'calm';

/** 同一套系统语音，用语速和音高做出三种明显不同的“人设” */
export const VOICE_PRESETS: Record<
  VoicePreset,
  { label: string; hint: string; rate: number; pitch: number }
> = {
  gentle: { label: '温柔', hint: '慢一点、软一点', rate: 0.88, pitch: 1.08 },
  lively: { label: '活泼', hint: '快一点、亮一点', rate: 1.12, pitch: 1.28 },
  calm: { label: '沉稳', hint: '低一点、稳一点', rate: 0.8, pitch: 0.85 },
};

export type VoiceOption = {
  id: string;
  name: string;
  language: string;
  quality?: string;
  isDefault?: boolean;
};

// 陪伴角色「林夏」是年轻女声，优先挑更像真人的中文女声。
// 前三个是 macOS / iOS 新系统里表现力更强的女声，比婷婷更不“机器”。
const PREFERRED_VOICES = [
  'flo (中文（中国大陆）)',
  'shelley (中文（中国大陆）)',
  'sandy (中文（中国大陆）)',
  'tingting',
  '婷婷',
  'meijia',
  '美嘉',
  '语舒',
];
const MALE_HINTS = ['eddy', 'reed', 'rocko', 'grandpa', 'li-mu', 'li mu', 'male'];

let cachedVoices: VoiceOption[] | null = null;

function isChineseVoice(voice: Speech.Voice) {
  const extra = voice as Speech.Voice & { lang?: string };
  return /^(zh|zho)/i.test(voice.language || extra.lang || '');
}

function waitForWebVoices(timeoutMs = 1500): Promise<Speech.Voice[]> {
  if (typeof window === 'undefined' || !window.speechSynthesis) return Promise.resolve([]);
  const synth = window.speechSynthesis;
  const existing = synth.getVoices();
  if (existing.length > 0) {
    // 不依赖 web 专有的 Voice 字段，保持和原生同一套 Voice 结构
    return Promise.resolve(existing as unknown as Speech.Voice[]);
  }

  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      synth.removeEventListener('voiceschanged', finish);
      resolve(synth.getVoices() as unknown as Speech.Voice[]);
    };
    const timer = setTimeout(finish, timeoutMs);
    synth.addEventListener('voiceschanged', finish);
  });
}

/** Web 上 getVoices 可能一直不返回，加个超时兜底，避免音色列表永远“读取中” */
function getVoicesWithTimeout(timeoutMs = 800): Promise<Speech.Voice[]> {
  const timeout = new Promise<Speech.Voice[]>((resolve) => {
    setTimeout(() => resolve([]), timeoutMs);
  });
  const call = Speech.getAvailableVoicesAsync().catch(() => [] as Speech.Voice[]);
  return Promise.race([call, timeout]);
}

export async function listChineseVoices(force = false): Promise<VoiceOption[]> {
  if (cachedVoices && !force) return cachedVoices;

  let voices = await getVoicesWithTimeout();
  if (Platform.OS === 'web' && voices.length === 0) {
    voices = await waitForWebVoices();
  }

  const mapped = voices
    .filter(isChineseVoice)
    .map((voice) => {
      // Web 的 Voice 没有 identifier/language，用 voiceURI/lang 兜底
      const extra = voice as Speech.Voice & { isDefault?: boolean; voiceURI?: string; lang?: string };
      return {
        id: voice.identifier || extra.voiceURI || voice.name,
        name: voice.name,
        language: voice.language || extra.lang || '',
        quality: String(voice.quality ?? ''),
        isDefault: extra.isDefault,
      };
    })
    .sort((a, b) => {
      if (a.isDefault && !b.isDefault) return -1;
      if (!a.isDefault && b.isDefault) return 1;
      return a.name.localeCompare(b.name);
    });

  // 空列表可能是还没加载完，不能缓存，否则整页会一直认为“没有音色”
  if (mapped.length > 0) cachedVoices = mapped;
  return mapped;
}

function scoreVoice(voice: VoiceOption) {
  const name = voice.name.toLowerCase();
  const language = voice.language.toLowerCase();
  let score = 0;
  if (voice.isDefault) score += 1;
  if (/(enhanced|premium|neural|natural)/i.test(`${voice.quality ?? ''} ${voice.name}`)) score += 4;
  if (/zh[-_]?(cn|hans)|cmn/i.test(language)) score += 6;
  else if (/zh/i.test(language)) score += 1;
  const preferredIndex = PREFERRED_VOICES.findIndex((hint) => name.includes(hint));
  if (preferredIndex >= 0) score += 12 - preferredIndex;
  if (MALE_HINTS.some((hint) => name.includes(hint))) score -= 10;
  return score;
}

export function pickPreferredVoice(voices: VoiceOption[]): VoiceOption | null {
  if (voices.length === 0) return null;
  return [...voices].sort((a, b) => scoreVoice(b) - scoreVoice(a))[0] ?? null;
}

/** 用户选过且当前设备还有这个声音就用它，否则自动挑一个中文女声 */
export async function resolveVoiceId(preferred?: string | null): Promise<string | null> {
  const voices = await listChineseVoices();
  if (preferred && voices.some((voice) => voice.id === preferred)) return preferred;
  return pickPreferredVoice(voices)?.id ?? null;
}

const SENTENCE_RE = /[^。！？!?；;\n…]+[。！？!?；;\n…]*/g;

/** 长句再按逗号拆短，避免一口气念完听起来更平 */
function splitLongClause(segment: string, maxLength = 48): string[] {
  if (segment.length <= maxLength) return [segment];
  const clauses = segment.match(/[^，,、：:]+[，,、：:]*/g) ?? [segment];
  const parts: string[] = [];
  let current = '';
  for (const clause of clauses) {
    if (current && current.length + clause.length > maxLength) {
      parts.push(current.trim());
      current = clause;
    } else {
      current += clause;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** 按句切分，朗读时逐句给不同语速/音高，听感比整段平铺自然 */
export function splitForSpeech(text: string): string[] {
  const clean = text.replace(/\r/g, '').trim();
  if (!clean) return [];
  const sentences = clean.match(SENTENCE_RE) ?? [clean];
  return sentences
    .flatMap((sentence) => splitLongClause(sentence.trim()))
    .filter((segment) => /[一-龥a-zA-Z0-9]/.test(segment));
}

const WOBBLE = [0, 0.03, -0.02, 0.02, -0.03, 0.01];

/** 在预设基础上做轻微起伏：问句上扬、感叹句更亮、省略号放慢 */
function prosodyFor(segment: string, index: number, base: { rate: number; pitch: number }) {
  let rate = base.rate;
  let pitch = base.pitch;
  if (/[？?]/.test(segment)) {
    pitch += 0.07;
    rate += 0.02;
  }
  if (/[！!]/.test(segment)) {
    pitch += 0.1;
    rate += 0.03;
  }
  if (/…|\.{3}/.test(segment)) {
    rate -= 0.06;
    pitch -= 0.02;
  }
  pitch += WOBBLE[index % WOBBLE.length];
  const clamp = (value: number) => Math.min(2, Math.max(0.5, value));
  return { rate: clamp(rate), pitch: clamp(pitch) };
}

/**
 * 一次只允许一句在说：新的朗读先 stop 掉旧的，这就是陪伴类 App 的 barge-in 基础。
 * 多句文本会拆成多段排队，每段语速/音高略有差异，避免整段一个调。
 */
export function speak(
  text: string,
  handlers: SpeakHandlers = {},
  options: { voice?: string | null; preset?: VoicePreset } = {}
) {
  const preset = VOICE_PRESETS[options.preset ?? 'gentle'];
  const segments = splitForSpeech(text);
  if (segments.length === 0) return;
  void Speech.stop();
  const voice = options.voice ?? undefined;

  if (segments.length === 1) {
    Speech.speak(segments[0], {
      language: 'zh-CN',
      rate: preset.rate,
      pitch: preset.pitch,
      voice,
      onStart: handlers.onStart,
      onDone: handlers.onDone,
      onStopped: handlers.onStopped,
      onError: handlers.onError,
    });
    return;
  }

  const lastIndex = segments.length - 1;
  segments.forEach((segment, index) => {
    const { rate, pitch } = prosodyFor(segment, index, preset);
    Speech.speak(segment, {
      language: 'zh-CN',
      rate,
      pitch,
      voice,
      onStart: index === 0 ? handlers.onStart : undefined,
      onDone: index === lastIndex ? handlers.onDone : undefined,
      onStopped: index === lastIndex ? handlers.onStopped : undefined,
      onError: handlers.onError,
    });
  });
}

export function stopSpeaking() {
  void Speech.stop();
}
