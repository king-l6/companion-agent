import AsyncStorage from '@react-native-async-storage/async-storage';

import type { ChatMessage } from './chat';
import type { VoicePreset } from './speech';
import type { ClonedSpeaker } from './voice-clone';

const MESSAGES_KEY = 'companion.messages.v1';
const ENTITLEMENT_KEY = 'companion.entitlement.v1';
const SOUND_KEY = 'companion.sound.v1';
const VOICE_KEY = 'companion.voice.v1';
const VOICE_PROFILE_KEY = 'companion.voiceProfile.v1';

export type PlanId = 'week' | 'month' | 'year';

export type Entitlement = {
  member: boolean;
  planId: PlanId | null;
  expiresAt: number | null;
  points: number;
};

export const DEFAULT_ENTITLEMENT: Entitlement = {
  member: false,
  planId: null,
  expiresAt: null,
  points: 20,
};

export async function loadMessages(): Promise<ChatMessage[]> {
  try {
    const raw = await AsyncStorage.getItem(MESSAGES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ChatMessage[]) : [];
  } catch {
    return [];
  }
}

export async function saveMessages(messages: ChatMessage[]): Promise<void> {
  try {
    // 只留最近 200 条，避免每次全量写越来越慢
    const kept = messages.length > 200 ? messages.slice(-200) : messages;
    await AsyncStorage.setItem(MESSAGES_KEY, JSON.stringify(kept));
  } catch {
    /* 本地缓存失败不影响对话 */
  }
}

export async function clearMessages(): Promise<void> {
  try {
    await AsyncStorage.removeItem(MESSAGES_KEY);
  } catch {
    /* ignore */
  }
}

export async function loadEntitlement(): Promise<Entitlement> {
  try {
    const raw = await AsyncStorage.getItem(ENTITLEMENT_KEY);
    if (!raw) return DEFAULT_ENTITLEMENT;
    const parsed = JSON.parse(raw) as Entitlement;
    if (parsed.expiresAt && parsed.expiresAt < Date.now()) {
      return { ...parsed, member: false };
    }
    return { ...DEFAULT_ENTITLEMENT, ...parsed };
  } catch {
    return DEFAULT_ENTITLEMENT;
  }
}

export async function saveEntitlement(entitlement: Entitlement): Promise<void> {
  try {
    await AsyncStorage.setItem(ENTITLEMENT_KEY, JSON.stringify(entitlement));
  } catch {
    /* ignore */
  }
}

export type VoiceSettings = {
  preset: VoicePreset;
  voiceId: string | null;
};

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  preset: 'gentle',
  voiceId: null,
};

const VALID_PRESETS: VoicePreset[] = ['gentle', 'lively', 'calm'];

export async function loadVoiceSettings(): Promise<VoiceSettings> {
  try {
    const raw = await AsyncStorage.getItem(VOICE_KEY);
    if (!raw) return DEFAULT_VOICE_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<VoiceSettings>;
    const preset = VALID_PRESETS.includes(parsed.preset as VoicePreset)
      ? (parsed.preset as VoicePreset)
      : DEFAULT_VOICE_SETTINGS.preset;
    return { preset, voiceId: typeof parsed.voiceId === 'string' ? parsed.voiceId : null };
  } catch {
    return DEFAULT_VOICE_SETTINGS;
  }
}

export async function saveVoiceSettings(settings: VoiceSettings): Promise<void> {
  try {
    await AsyncStorage.setItem(VOICE_KEY, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
}

/**
 * 用户从音频/视频里提取出来的克隆音色。
 * 参考音频和参考文本都在本地音色服务里，这里只存索引和展示信息。
 */
export type VoiceProfile = {
  jobId: string;
  duration: number;
  speakers: ClonedSpeaker[];
  /** null 表示回到系统 TTS */
  selectedId: string | null;
  sourceName: string;
  createdAt: number;
};

export async function loadVoiceProfile(): Promise<VoiceProfile | null> {
  try {
    const raw = await AsyncStorage.getItem(VOICE_PROFILE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<VoiceProfile>;
    if (!parsed.jobId || !Array.isArray(parsed.speakers) || parsed.speakers.length === 0) {
      return null;
    }
    return {
      jobId: parsed.jobId,
      duration: Number(parsed.duration ?? 0),
      speakers: parsed.speakers,
      selectedId: typeof parsed.selectedId === 'string' ? parsed.selectedId : null,
      sourceName: typeof parsed.sourceName === 'string' ? parsed.sourceName : '本地音视频',
      createdAt: Number(parsed.createdAt ?? 0),
    };
  } catch {
    return null;
  }
}

export async function saveVoiceProfile(profile: VoiceProfile): Promise<void> {
  try {
    await AsyncStorage.setItem(VOICE_PROFILE_KEY, JSON.stringify(profile));
  } catch {
    /* ignore */
  }
}

export async function clearVoiceProfile(): Promise<void> {
  try {
    await AsyncStorage.removeItem(VOICE_PROFILE_KEY);
  } catch {
    /* ignore */
  }
}

export async function loadSoundOn(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(SOUND_KEY);
    return raw === null ? true : raw === '1';
  } catch {
    return true;
  }
}

export async function saveSoundOn(on: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(SOUND_KEY, on ? '1' : '0');
  } catch {
    /* ignore */
  }
}
