import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioRecorder,
  useAudioRecorderState,
  type AudioPlayer,
} from 'expo-audio';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ChatBubble } from '@/components/chat-bubble';
import { PaywallSheet } from '@/components/paywall-sheet';
import { BottomTabInset, Companion, Spacing } from '@/constants/theme';
import { track } from '@/lib/analytics';
import {
  hasServerAsr,
  hasWebSpeechRecognition,
  recognizeWebSpeech,
  transcribeAudio,
  type WebAsrSession,
} from '@/lib/asr';
import {
  createMockStream,
  createSeedMessages,
  newTraceId,
  uid,
  type ChatMessage,
  type ChatStatus,
  type StreamHandle,
} from '@/lib/chat';
import { createChatStream, hasLlmConfig, type LlmMessage } from '@/lib/llm';
import { resolveVoiceId, speak, splitForSpeech, stopSpeaking } from '@/lib/speech';
import {
  DEFAULT_ENTITLEMENT,
  DEFAULT_VOICE_SETTINGS,
  loadEntitlement,
  loadMessages,
  loadSoundOn,
  loadVoiceProfile,
  loadVoiceSettings,
  saveMessages,
  saveSoundOn,
  type Entitlement,
  type VoiceProfile,
  type VoiceSettings,
} from '@/lib/storage';
import { synthesizeSpeech, ttsUrl } from '@/lib/voice-clone';

const SCENE = require('@/assets/images/scene-tavern.jpg');
const SUGGESTIONS = ['你是谁？', '带我看看这个世界', '我今天有点累'];
const FREE_LIMIT = 5;
const MIN_SPEECH_MS = 700;
// 配了自己的 ASR 接口就统一走录音上传；否则 Web 用浏览器原生识别，原生才回退 mock
const SERVER_ASR = hasServerAsr();
const WEB_ASR = !SERVER_ASR && hasWebSpeechRecognition();
// 配了模型 Key 就走真模型，没配才退回本地 mock
const USE_LLM = hasLlmConfig();
const MOCK_TRANSCRIPTS = [
  '我想听你讲讲那座会移动的森林。',
  '今天晚上酒馆里有什么故事？',
  '我今天有点累，想在这里坐一会儿。',
];

type VoicePhase = 'idle' | 'requesting' | 'recording' | 'transcribing';

const keyExtractor = (item: ChatMessage) => item.id;

/**
 * 离线演示用的假转写：只在原生端没配 EXPO_PUBLIC_ASR_URL 时走到这里。
 * Web 端不会用它，真识别由 lib/asr.ts 负责。
 */
function mockTranscribe(durationMs: number) {
  if (durationMs < MIN_SPEECH_MS) return '';
  return MOCK_TRANSCRIPTS[Math.floor(durationMs / 1000) % MOCK_TRANSCRIPTS.length];
}

function voiceErrorMessage(error: unknown) {
  const name = (error as { name?: string })?.name ?? '';
  const message = String((error as { message?: string })?.message ?? error ?? '');
  if (/service-not-allowed/i.test(message)) {
    return '当前浏览器禁止了语音识别服务，请检查浏览器设置。';
  }
  if (
    name === 'NotAllowedError' ||
    /^not-allowed$|permission|denied/i.test(message)
  ) {
    return '麦克风权限被拒绝。请在浏览器地址栏或系统设置里允许麦克风，再点重试。';
  }
  if (name === 'NotFoundError' || /audio-capture|not found|no.*device/i.test(message)) {
    return '没有检测到麦克风，请检查设备后再试。';
  }
  if (name === 'NotReadableError' || /could not start|in use/i.test(message)) {
    return '麦克风被其他应用占用，请关闭后重试。';
  }
  if (/^network$|network/i.test(message)) {
    return '语音识别服务连不上，请检查网络后再试。';
  }
  if (/language-not-supported/i.test(message)) {
    return '当前浏览器不支持中文语音识别。';
  }
  if (/^timeout$/.test(message)) {
    return '识别超时了，请点重试再说一遍。';
  }
  if (/unsupported|not supported/i.test(message)) {
    return '当前浏览器不支持语音识别，请换 Chrome / Edge / Safari 试试。';
  }
  if (message === 'permission_timeout') {
    return '麦克风权限请求超时，请点重试。';
  }
  return `语音识别失败：${message || '未知错误'}`;
}

async function requestMicPermissionWithTimeout() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      requestRecordingPermissionsAsync(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('permission_timeout')), 15_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 等一段克隆语音播完。
 * Web 端 expo-audio 的 onended 不一定发状态事件，所以除监听外再轮询 currentStatus。
 */
function waitForCloneEnd(
  player: AudioPlayer,
  isCurrent: () => boolean,
  timeoutMs = 90_000
): Promise<'done' | 'canceled' | 'error'> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: 'done' | 'canceled' | 'error') => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      clearTimeout(timeout);
      subscription.remove();
      resolve(result);
    };

    const subscription = player.addListener('playbackStatusUpdate', (status) => {
      if (status.error) finish('error');
      else if (status.didJustFinish) finish('done');
    });

    const timer = setInterval(() => {
      if (!isCurrent()) return finish('canceled');
      const status = player.currentStatus;
      if (status.error) return finish('error');
      if (status.didJustFinish) finish('done');
    }, 150);

    const timeout = setTimeout(() => finish('done'), timeoutMs);
  });
}

function formatDuration(ms: number) {
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60)
    .toString()
    .padStart(2, '0');
  const seconds = (total % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

export default function ChatScreen() {
  const insets = useSafeAreaInsets();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [soundOn, setSoundOn] = useState(true);
  const [speaking, setSpeaking] = useState(false);
  const [paywallVisible, setPaywallVisible] = useState(false);
  const [entitlement, setEntitlement] = useState<Entitlement>(DEFAULT_ENTITLEMENT);
  const [voicePhase, setVoicePhase] = useState<VoicePhase>('idle');
  const [voiceNotice, setVoiceNotice] = useState('');
  const [interimText, setInterimText] = useState('');
  const [recordMs, setRecordMs] = useState(0);
  const [toast, setToast] = useState('');
  const [voiceProfile, setVoiceProfile] = useState<VoiceProfile | null>(null);

  const listRef = useRef<FlashListRef<ChatMessage>>(null);
  const nearBottomRef = useRef(true);
  const bufferRef = useRef('');
  const fullTextRef = useRef('');
  const targetIdRef = useRef<string | null>(null);
  const flushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const streamHandleRef = useRef<StreamHandle | null>(null);
  const soundOnRef = useRef(true);
  const streamingRef = useRef(false);
  const speechSeqRef = useRef(0);
  const speechTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voicePhaseRef = useRef<VoicePhase>('idle');
  const voiceSettingsRef = useRef<VoiceSettings>(DEFAULT_VOICE_SETTINGS);
  const resolvedVoiceRef = useRef<string | null>(null);
  const voiceProfileRef = useRef<VoiceProfile | null>(null);
  const cloneControllersRef = useRef<AbortController[]>([]);
  const clonePlayer = useAudioPlayer();
  const recordStartedAtRef = useRef(0);
  const stoppingRef = useRef(false);
  const asrSessionRef = useRef<WebAsrSession | null>(null);

  const recording = voicePhase === 'recording';
  const voiceBusy = voicePhase !== 'idle';

  const updateVoicePhase = useCallback((phase: VoicePhase) => {
    voicePhaseRef.current = phase;
    setVoicePhase(phase);
  }, []);

  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder, 200);

  const userTurns = messages.filter(
    (message) => message.role === 'user' && !message.id.startsWith('seed-')
  ).length;
  const remaining = Math.max(0, FREE_LIMIT - userTurns);
  const clonedSpeaker = voiceProfile?.selectedId
    ? voiceProfile.speakers.find((item) => item.id === voiceProfile.selectedId) ?? null
    : null;

  useEffect(() => {
    streamingRef.current = streaming;
  }, [streaming]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 2200);
    return () => clearTimeout(timer);
  }, [toast]);

  /** 回到页面时恢复会话、会员状态和声音开关；清空会话后也能立即生效 */
  useFocusEffect(
    useCallback(() => {
      let active = true;
      void (async () => {
        const [saved, savedEntitlement, savedSound, savedVoice, savedProfile] =
          await Promise.all([
            loadMessages(),
            loadEntitlement(),
            loadSoundOn(),
            loadVoiceSettings(),
            loadVoiceProfile(),
          ]);
        if (!active) return;
        if (!streamingRef.current) setMessages(saved);
        setEntitlement(savedEntitlement);
        setSoundOn(savedSound);
        soundOnRef.current = savedSound;
        voiceSettingsRef.current = savedVoice;
        setVoiceProfile(savedProfile);
        voiceProfileRef.current = savedProfile;
        setLoaded(true);
        // 说明页改完声音后回到这里，重新解析一次，旧设备上不存在的音色会自动回退
        resolvedVoiceRef.current = await resolveVoiceId(savedVoice.voiceId);
      })();
      return () => {
        active = false;
      };
    }, [])
  );

  /** 消息落盘做 400ms 防抖，流式期间不会每个 token 都写一次 */
  useEffect(() => {
    if (!loaded) return;
    const timer = setTimeout(() => void saveMessages(messages), 400);
    return () => clearTimeout(timer);
  }, [loaded, messages]);

  useEffect(
    () => () => {
      streamHandleRef.current?.abort();
      if (flushTimerRef.current) clearInterval(flushTimerRef.current);
      if (speechTimerRef.current) clearTimeout(speechTimerRef.current);
      speechSeqRef.current += 1;
      stopSpeaking();
      cloneControllersRef.current.forEach((controller) => controller.abort());
      cloneControllersRef.current = [];
      clonePlayer.pause();
      asrSessionRef.current?.stop();
      asrSessionRef.current = null;
    },
    [clonePlayer]
  );

  /** 停朗读并让上一句的异步回调失效 */
  const haltSpeech = useCallback(() => {
    speechSeqRef.current += 1;
    if (speechTimerRef.current) {
      clearTimeout(speechTimerRef.current);
      speechTimerRef.current = null;
    }
    stopSpeaking();
    // 克隆音色走独立播放器：停掉播放，并中断还在合成的请求
    cloneControllersRef.current.forEach((controller) => controller.abort());
    cloneControllersRef.current = [];
    clonePlayer.pause();
    setSpeaking(false);
  }, [clonePlayer]);

  useEffect(() => {
    if (!nearBottomRef.current) return;
    const frame = requestAnimationFrame(() => {
      listRef.current?.scrollToEnd({ animated: false });
    });
    return () => cancelAnimationFrame(frame);
  }, [messages]);

  /** 用克隆音色逐句合成并播放；失败时由 speakText 回退系统 TTS */
  const playClonedVoice = useCallback(
    async (
      text: string,
      speaker: string,
      seq: number,
      handlers: { onDone: () => void; onError: (message: string) => void }
    ) => {
      const segments = splitForSpeech(text);
      if (segments.length === 0) {
        handlers.onDone();
        return;
      }

      const isCurrent = () => seq === speechSeqRef.current;
      const useBlob =
        Platform.OS === 'web' && typeof URL !== 'undefined' && !!URL.createObjectURL;
      const controllers: AbortController[] = [];
      const objectUrls: string[] = [];
      cloneControllersRef.current = controllers;

      const load = (index: number): Promise<string> => {
        if (!useBlob) return Promise.resolve(ttsUrl(segments[index], speaker));
        const controller = new AbortController();
        controllers.push(controller);
        return synthesizeSpeech(segments[index], speaker, { signal: controller.signal }).then(
          (blob) => {
            const url = URL.createObjectURL(blob);
            objectUrls.push(url);
            return url;
          }
        );
      };

      // 并发请求所有句子：第一段在播时，后面的已经在合成，句间几乎无停顿
      const pending = segments.map((_, index) => load(index));
      // 被 barge-in 取消的请求不能留下未处理的 rejection
      pending.forEach((item) => item.catch(() => {}));

      try {
        for (let index = 0; index < segments.length; index += 1) {
          if (!isCurrent()) return;
          const url = await pending[index];
          if (!isCurrent()) return;

          clonePlayer.replace({ uri: url });
          clonePlayer.play();

          const outcome = await waitForCloneEnd(clonePlayer, isCurrent);
          if (outcome === 'canceled') return;
          if (outcome === 'error') throw new Error('克隆音色播放失败');
        }
        if (isCurrent()) handlers.onDone();
      } catch (error) {
        if (!isCurrent()) return;
        handlers.onError(String((error as Error)?.message ?? error));
      } finally {
        controllers.forEach((controller) => controller.abort());
        if (cloneControllersRef.current === controllers) cloneControllersRef.current = [];
        // 播放结束后再释放，避免正在播的音频被回收
        setTimeout(() => {
          objectUrls.forEach((url) => URL.revokeObjectURL(url));
        }, 2_000);
      }
    },
    [clonePlayer]
  );

  const speakText = useCallback((text: string, reason: string) => {
    if (!text.trim()) return;

    const seq = speechSeqRef.current + 1;
    speechSeqRef.current = seq;

    if (speechTimerRef.current) clearTimeout(speechTimerRef.current);
    stopSpeaking();
    setSpeaking(true);

    const end = (event: string, extra: Record<string, unknown> = {}) => {
      if (seq !== speechSeqRef.current) return;
      if (speechTimerRef.current) {
        clearTimeout(speechTimerRef.current);
        speechTimerRef.current = null;
      }
      setSpeaking(false);
      void track(event, { reason, ...extra });
    };

    const speakWithSystem = () => {
      speak(
        text,
        {
          onDone: () => end('tts_done', { engine: 'system' }),
          onStopped: () => end('tts_stopped', { engine: 'system' }),
          onError: () => end('tts_error', { engine: 'system' }),
        },
        { voice: resolvedVoiceRef.current, preset: voiceSettingsRef.current.preset }
      );
    };

    const profile = voiceProfileRef.current;
    const speaker = profile?.selectedId
      ? profile.speakers.find((item) => item.id === profile.selectedId) ?? null
      : null;

    void track('tts_start', {
      reason,
      chars: text.length,
      engine: speaker ? 'cloned' : 'system',
    });

    if (speaker) {
      void playClonedVoice(text, speaker.id, seq, {
        onDone: () => end('tts_done', { engine: 'cloned' }),
        onError: () => {
          if (seq !== speechSeqRef.current) return;
          setToast('克隆音色不可用，已切回系统语音');
          void track('tts_clone_fallback', { speaker: speaker.id });
          speakWithSystem();
        },
      });

      // 合成 + 播放的兜底超时，避免服务卡住时一直显示“正在说话”
      speechTimerRef.current = setTimeout(
        () => end('tts_timeout', { engine: 'cloned' }),
        Math.min(180_000, 8_000 + text.length * 300)
      );
      return;
    }

    speakWithSystem();

    // 某些 WebView / 无声设备不会回调 onDone，用估算时长兜底，避免“正在说话”卡住
    speechTimerRef.current = setTimeout(
      () => end('tts_timeout', { engine: 'system' }),
      Math.min(90_000, 1_500 + text.length * 180)
    );
  }, [playClonedVoice]);

  const flush = useCallback(() => {
    const id = targetIdRef.current;
    const buffered = bufferRef.current;
    if (!id || !buffered) return;
    bufferRef.current = '';
    setMessages((prev) =>
      prev.map((message) =>
        message.id === id ? { ...message, content: message.content + buffered } : message
      )
    );
  }, []);

  const finish = useCallback(
    (status: ChatStatus) => {
      flush();
      if (flushTimerRef.current) {
        clearInterval(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      const id = targetIdRef.current;
      if (id) {
        setMessages((prev) =>
          prev.map((message) => (message.id === id ? { ...message, status } : message))
        );
      }
      targetIdRef.current = null;
      setStreaming(false);

      if (status === 'done' && soundOnRef.current) {
        speakText(fullTextRef.current, 'auto');
      }
    },
    [flush, speakText]
  );

  const openPaywall = useCallback(
    (source: string) => {
      haltSpeech();
      void track('paywall_open', { source });
      setPaywallVisible(true);
    },
    [haltSpeech]
  );

  const send = useCallback(
    (raw?: string) => {
      const text = (raw ?? input).trim();
      // 用 ref 判断，避免 stopRecording 里拿到旧的 recording=true 闭包把自己拦掉
      if (!text || streamingRef.current || voicePhaseRef.current !== 'idle') return;

      if (!entitlement.member && remaining <= 0) {
        setToast('免费次数已用完，开通会员继续');
        void track('paywall_block', { remaining });
        openPaywall('limit');
        return;
      }

      // barge-in：用户一开口，先停掉正在朗读的回复
      haltSpeech();

      const traceId = newTraceId();
      const assistantId = uid('a');
      const now = Date.now();

      setMessages((prev) => [
        ...prev,
        {
          id: uid('u'),
          role: 'user',
          content: text,
          status: 'done',
          traceId,
          createdAt: now,
        },
        {
          id: assistantId,
          role: 'assistant',
          content: '',
          status: 'streaming',
          traceId,
          createdAt: now + 1,
        },
      ]);
      setInput('');
      nearBottomRef.current = true;
      setStreaming(true);

      targetIdRef.current = assistantId;
      bufferRef.current = '';
      fullTextRef.current = '';
      if (flushTimerRef.current) clearInterval(flushTimerRef.current);
      flushTimerRef.current = setInterval(flush, 50);

      void track('chat_send', {
        traceId,
        chars: text.length,
        engine: USE_LLM ? 'llm' : 'mock',
      });

      const handlers = {
        onDelta(chunk: string) {
          bufferRef.current += chunk;
          fullTextRef.current += chunk;
        },
        onDone() {
          finish('done');
        },
        onError(error?: Error) {
          finish('error');
          if (USE_LLM) {
            setToast(`模型请求失败：${(error?.message ?? '未知错误').slice(0, 80)}`);
          }
        },
      };

      if (USE_LLM) {
        // 只带最近几轮完整消息，避免上下文无限增长；seed 压测数据不发给模型
        const history: LlmMessage[] = messages
          .filter(
            (message) =>
              message.status === 'done' &&
              message.content.trim().length > 0 &&
              !message.id.startsWith('seed-')
          )
          .slice(-12)
          .map((message) => ({ role: message.role, content: message.content }));

        streamHandleRef.current = createChatStream({
          messages: [...history, { role: 'user', content: text }],
          handlers,
        });
      } else {
        streamHandleRef.current = createMockStream(text, handlers);
      }
    },
    [
      entitlement.member,
      finish,
      flush,
      haltSpeech,
      input,
      messages,
      openPaywall,
      remaining,
    ]
  );

  /** 识别完成后的统一收尾：空结果提示重试，有结果直接发送 */
  const handleRecognizedText = useCallback(
    async (text: string, measuredMs: number) => {
      setRecordMs(measuredMs);
      updateVoicePhase('transcribing');
      await new Promise((resolve) => setTimeout(resolve, text ? 150 : 100));
      if (voicePhaseRef.current !== 'transcribing') return;

      if (!text) {
        updateVoicePhase('idle');
        setInterimText('');
        setVoiceNotice(
          measuredMs < MIN_SPEECH_MS
            ? `只录到 ${(measuredMs / 1000).toFixed(1)} 秒，没听清。按住多说一会儿再试。`
            : '没有识别到说话内容，再说一遍？'
        );
        void track('voice_empty', { durationMs: measuredMs });
        return;
      }

      updateVoicePhase('idle');
      setInterimText('');
      setVoiceNotice('');
      void track('voice_transcribed', { durationMs: measuredMs, chars: text.length });
      send(text);
    },
    [send, updateVoicePhase]
  );

  const stop = useCallback(() => {
    streamHandleRef.current?.abort();
    streamHandleRef.current = null;
    finish('stopped');
    void track('chat_stop');
  }, [finish]);

  const toggleSound = useCallback(() => {
    const next = !soundOnRef.current;
    soundOnRef.current = next;
    setSoundOn(next);
    void saveSoundOn(next);
    void track('sound_toggle', { on: next });
    if (!next) {
      haltSpeech();
    }
  }, [haltSpeech]);

  /** Web 端录音期间不刷新 durationMillis，这里自己计时，避免一直显示 00:00 */
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => {
      setRecordMs(Date.now() - recordStartedAtRef.current);
    }, 200);
    return () => clearInterval(timer);
  }, [recording]);

  const startRecording = useCallback(async () => {
    if (streamingRef.current || voicePhaseRef.current !== 'idle') return;
    // barge-in：一开口就停掉正在朗读的回复
    haltSpeech();
    setVoiceNotice('');
    setInterimText('');
    updateVoicePhase('requesting');
    void track('voice_record_start', { engine: WEB_ASR ? 'web-speech' : 'recorder' });

    if (WEB_ASR) {
      try {
        const session = recognizeWebSpeech({
          onInterim: (text) => setInterimText(text),
        });
        asrSessionRef.current = session;
        stoppingRef.current = false;
        recordStartedAtRef.current = Date.now();
        setRecordMs(0);
        updateVoicePhase('recording');

        void (async () => {
          try {
            const text = await session.promise;
            // 说完一句浏览器会自动结束识别，此时还停在 recording
            if (
              voicePhaseRef.current !== 'recording' &&
              voicePhaseRef.current !== 'transcribing'
            ) {
              return;
            }
            await handleRecognizedText(text, Date.now() - recordStartedAtRef.current);
          } catch (error) {
            if (voicePhaseRef.current === 'idle') return;
            updateVoicePhase('idle');
            setInterimText('');
            setVoiceNotice(voiceErrorMessage(error));
            void track('voice_record_error', { engine: 'web-speech', message: String(error) });
          } finally {
            if (asrSessionRef.current === session) asrSessionRef.current = null;
          }
        })();
        return;
      } catch (error) {
        updateVoicePhase('idle');
        setVoiceNotice(voiceErrorMessage(error));
        void track('voice_record_error', { engine: 'web-speech', message: String(error) });
        return;
      }
    }

    try {
      const permission = await requestMicPermissionWithTimeout();
      if (!permission.granted) {
        updateVoicePhase('idle');
        setVoiceNotice('麦克风权限被拒绝。请在浏览器地址栏或系统设置里允许麦克风，再点重试。');
        void track('voice_permission_denied');
        return;
      }

      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      stoppingRef.current = false;
      recordStartedAtRef.current = Date.now();
      setRecordMs(0);
      updateVoicePhase('recording');
    } catch (error) {
      updateVoicePhase('idle');
      setVoiceNotice(voiceErrorMessage(error));
      void track('voice_record_error', { message: String(error) });
    }
  }, [handleRecognizedText, haltSpeech, recorder, updateVoicePhase]);

  const stopRecording = useCallback(async () => {
    if (voicePhaseRef.current !== 'recording' || stoppingRef.current) return;
    stoppingRef.current = true;

    const measuredMs = Math.max(
      Date.now() - recordStartedAtRef.current,
      recorderState.durationMillis
    );
    setRecordMs(measuredMs);
    updateVoicePhase('transcribing');

    // Web：stop() 让浏览器把最后一段结果吐出来，收尾在 startRecording 的 promise 里
    if (WEB_ASR) {
      asrSessionRef.current?.stop();
      return;
    }

    try {
      await recorder.stop();
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
      void track('voice_record_stop', { durationMs: measuredMs });

      // 原生：配置了 ASR 接口就上传真识别，没配置才退到离线 mock
      let text = await transcribeAudio(recorder.uri);
      const engine = text === null ? 'mock' : 'remote';
      if (text === null) text = mockTranscribe(measuredMs);
      void track('voice_asr_done', { engine, chars: text.length });

      await handleRecognizedText(text, measuredMs);
    } catch (error) {
      updateVoicePhase('idle');
      setVoiceNotice(voiceErrorMessage(error));
      void track('voice_record_error', { message: String(error) });
    } finally {
      stoppingRef.current = false;
    }
  }, [handleRecognizedText, recorder, recorderState.durationMillis, updateVoicePhase]);

  const injectHistory = useCallback(() => {
    setMessages((prev) => [...createSeedMessages(500), ...prev]);
    nearBottomRef.current = true;
    void track('debug_inject_500');
  }, []);

  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    nearBottomRef.current =
      contentSize.height - (contentOffset.y + layoutMeasurement.height) < 140;
  }, []);

  const renderItem = useCallback(
    ({ item }: { item: ChatMessage }) => (
      <ChatBubble
        message={item}
        onSpeak={
          item.role === 'assistant' && item.status === 'done'
            ? () => speakText(item.content, 'replay')
            : undefined
        }
      />
    ),
    [speakText]
  );

  const handleKeyPress = useCallback(
    (event: NativeSyntheticEvent<{ key: string; shiftKey?: boolean }>) => {
      if (Platform.OS !== 'web') return;
      if (event.nativeEvent.key === 'Enter' && !event.nativeEvent.shiftKey) {
        event.preventDefault();
        send();
      }
    },
    [send]
  );

  const onPurchased = useCallback((next: Entitlement) => {
    setEntitlement(next);
  }, []);

  return (
    <View style={styles.container}>
      <Image source={SCENE} style={StyleSheet.absoluteFill} contentFit="cover" />
      <LinearGradient
        colors={['rgba(5,4,10,0.92)', 'rgba(5,4,10,0.4)', 'rgba(5,4,10,0)']}
        locations={[0, 0.55, 1]}
        style={styles.topScrim}
        pointerEvents="none"
      />
      <LinearGradient
        colors={['rgba(7,5,11,0)', 'rgba(7,5,11,0.7)', 'rgba(7,5,11,0.97)']}
        locations={[0, 0.45, 1]}
        style={styles.bottomScrim}
        pointerEvents="none"
      />

      <View
        style={[styles.header, { paddingTop: Platform.OS === 'web' ? 66 : insets.top + 10 }]}>
        <Pressable onLongPress={injectHistory} delayLongPress={600} hitSlop={8}>
          <View style={styles.avatarRing}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>夏</Text>
            </View>
          </View>
        </Pressable>

        <View style={styles.headerText}>
          <Text style={styles.name}>林夏</Text>
          <View style={styles.statusRow}>
            <View style={styles.dot} />
            <Text style={styles.status}>
              {speaking
                ? '正在说话…'
                : clonedSpeaker
                  ? `克隆音色 · ${clonedSpeaker.label}`
                  : '在线 · 雨夜酒馆'}
            </Text>
          </View>
        </View>

        <Pressable onPress={toggleSound} hitSlop={8} style={styles.glassIcon}>
          <Text style={styles.soundIcon}>{soundOn ? '🔊' : '🔇'}</Text>
        </Pressable>

        <Pressable
          onPress={() => openPaywall('header')}
          style={({ pressed }) => [
            styles.pill,
            entitlement.member && styles.pillActive,
            pressed && styles.pressed,
          ]}>
          <Text style={[styles.pillText, entitlement.member && styles.pillTextActive]}>
            {entitlement.member ? '已开通' : `会员 · 剩${remaining}`}
          </Text>
        </Pressable>
      </View>

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={0}>
        <FlashList
          ref={listRef}
          data={messages}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          onScroll={handleScroll}
          scrollEventThrottle={16}
          keyboardShouldPersistTaps="handled"
          style={styles.flex}
          contentContainerStyle={
            messages.length === 0 ? styles.emptyContent : styles.listContent
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.chapter}>序章 · 雨夜酒馆</Text>
              <Text style={styles.opening}>
                雨夜，她把一杯温热的酒推到你面前。{'\n'}「坐吧，今晚的故事还长。」
              </Text>
              <View style={styles.chips}>
                {SUGGESTIONS.map((suggestion) => (
                  <Pressable
                    key={suggestion}
                    onPress={() => send(suggestion)}
                    disabled={voiceBusy || streaming}
                    style={({ pressed }) => [
                      styles.chip,
                      (voiceBusy || streaming) && styles.disabled,
                      pressed && styles.pressed,
                    ]}>
                    <Text style={styles.chipMark}>✦</Text>
                    <Text style={styles.chipText}>{suggestion}</Text>
                  </Pressable>
                ))}
              </View>
              <Text style={styles.emptyHint}>点一句开场，或开口直接说</Text>
            </View>
          }
        />

        <View
          style={[
            styles.composer,
            {
              paddingBottom:
                Platform.OS === 'web' ? Spacing.three : BottomTabInset + Spacing.two,
            },
          ]}>
          {speaking ? (
            <Pressable
              onPress={() => {
                haltSpeech();
                void track('tts_stop_by_user');
              }}
              style={styles.speakingBar}>
              <Text style={styles.speakingText}>
                ♪ 林夏正在说话{clonedSpeaker ? ` · 克隆音色 ${clonedSpeaker.label}` : ''} · 点击停止
              </Text>
            </Pressable>
          ) : null}

          {voiceNotice ? (
            <View style={styles.voiceNotice}>
              <Text style={styles.voiceNoticeText}>{voiceNotice}</Text>
              <Pressable
                onPress={() => {
                  setVoiceNotice('');
                  void startRecording();
                }}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="重新录音">
                <Text style={styles.voiceNoticeAction}>重试</Text>
              </Pressable>
              <Pressable
                onPress={() => setVoiceNotice('')}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="关闭提示">
                <Text style={styles.voiceNoticeClose}>×</Text>
              </Pressable>
            </View>
          ) : null}

          {toast ? <Text style={styles.toast}>{toast}</Text> : null}

          <View style={styles.inputRow}>
            <View
              style={[
                styles.capsule,
                voicePhase === 'recording' && styles.capsuleRecording,
              ]}>
              <Pressable
                onPress={() => {
                  if (voicePhase === 'recording') {
                    void stopRecording();
                  } else if (voicePhase === 'idle') {
                    void startRecording();
                  }
                }}
                disabled={
                  streaming || voicePhase === 'requesting' || voicePhase === 'transcribing'
                }
                accessibilityRole="button"
                accessibilityLabel={
                  voicePhase === 'recording'
                    ? '结束录音并发送'
                    : voicePhase === 'requesting'
                      ? '正在获取麦克风权限'
                      : voicePhase === 'transcribing'
                        ? '正在识别语音'
                        : '开始录音'
                }
                style={({ pressed }) => [
                  styles.micButton,
                  voicePhase === 'recording' && styles.micButtonRecording,
                  (streaming ||
                    voicePhase === 'requesting' ||
                    voicePhase === 'transcribing') &&
                    styles.disabled,
                  pressed && styles.pressed,
                ]}>
                {voicePhase === 'requesting' || voicePhase === 'transcribing' ? (
                  <ActivityIndicator size="small" color={Companion.accent} />
                ) : (
                  <Text style={styles.micIcon}>{voicePhase === 'recording' ? '■' : '🎙'}</Text>
                )}
              </Pressable>

              {voicePhase === 'recording' ? (
                <Pressable
                  onPress={() => void stopRecording()}
                  accessibilityRole="button"
                  accessibilityLabel="结束录音并发送"
                  style={styles.recordingBody}>
                  <View style={styles.recordingDot} />
                  <Text style={styles.recordingText}>
                    {formatDuration(Math.max(recordMs, recorderState.durationMillis))}
                  </Text>
                  <Text numberOfLines={1} style={styles.recordingHint}>
                    {WEB_ASR
                      ? interimText
                        ? `“${interimText}”`
                        : '正在听，点此结束'
                      : '正在录音，点此结束'}
                  </Text>
                </Pressable>
              ) : voicePhase === 'requesting' || voicePhase === 'transcribing' ? (
                <View style={styles.recordingBody}>
                  <Text style={styles.recordingText}>
                    {voicePhase === 'requesting' ? '正在获取麦克风权限…' : '正在识别语音…'}
                  </Text>
                </View>
              ) : (
                <TextInput
                  value={input}
                  onChangeText={setInput}
                  onKeyPress={handleKeyPress}
                  placeholder="说点什么…"
                  placeholderTextColor={Companion.textTertiary}
                  selectionColor={Companion.accent}
                  multiline
                  style={styles.input}
                />
              )}

              <Pressable
                onPress={streaming ? stop : () => send()}
                disabled={streaming ? false : input.trim().length === 0 || voiceBusy}
                style={({ pressed }) => [
                  !streaming &&
                    (input.trim().length === 0 || voiceBusy) &&
                    styles.disabled,
                  pressed && styles.pressed,
                ]}>
                <LinearGradient
                  colors={streaming ? ['#4B3C5E', '#4B3C5E'] : Companion.gradient}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={styles.sendButton}>
                  <Text style={styles.sendText}>{streaming ? '■' : '↑'}</Text>
                </LinearGradient>
              </Pressable>
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>

      <PaywallSheet
        visible={paywallVisible}
        entitlement={entitlement}
        onClose={() => setPaywallVisible(false)}
        onPurchased={onPurchased}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Companion.background,
  },
  flex: {
    flex: 1,
  },
  topScrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 260,
  },
  bottomScrim: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 460,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingBottom: 12,
    gap: 10,
  },
  avatarRing: {
    width: 42,
    height: 42,
    borderRadius: 21,
    padding: 2,
    borderWidth: 1,
    borderColor: 'rgba(255,185,138,0.55)',
    backgroundColor: 'rgba(10,7,16,0.45)',
  },
  avatar: {
    flex: 1,
    borderRadius: 18,
    backgroundColor: '#2A1730',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    color: Companion.warm,
    fontSize: 16,
    fontWeight: '700',
  },
  headerText: {
    flex: 1,
    marginLeft: 2,
  },
  name: {
    color: Companion.text,
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 3,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: Companion.online,
    marginRight: 6,
  },
  status: {
    color: Companion.textSecondary,
    fontSize: 11.5,
  },
  glassIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Companion.glass,
    borderWidth: 1,
    borderColor: Companion.border,
  },
  soundIcon: {
    fontSize: 14,
  },
  pill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: Companion.glass,
    borderWidth: 1,
    borderColor: Companion.border,
  },
  pillActive: {
    backgroundColor: Companion.accentSoft,
    borderColor: 'rgba(201,167,255,0.45)',
  },
  pillText: {
    color: Companion.textSecondary,
    fontSize: 11,
    fontWeight: '600',
  },
  pillTextActive: {
    color: Companion.accent,
  },
  listContent: {
    paddingTop: 12,
    paddingBottom: 8,
  },
  emptyContent: {
    flexGrow: 1,
  },
  empty: {
    flex: 1,
    justifyContent: 'flex-end',
    paddingHorizontal: 26,
    paddingBottom: 18,
  },
  chapter: {
    color: Companion.warm,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 3,
    marginBottom: 12,
  },
  opening: {
    color: Companion.text,
    fontSize: 19,
    lineHeight: 31,
    letterSpacing: 0.4,
    textShadowColor: 'rgba(0,0,0,0.55)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 12,
  },
  chips: {
    marginTop: 26,
    gap: 10,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 13,
    borderRadius: 16,
    backgroundColor: 'rgba(16,11,25,0.55)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.09)',
  },
  chipMark: {
    color: Companion.warm,
    fontSize: 12,
  },
  chipText: {
    color: Companion.text,
    fontSize: 14,
    flexShrink: 1,
  },
  emptyHint: {
    color: Companion.textTertiary,
    fontSize: 11,
    marginTop: 16,
  },
  composer: {
    paddingHorizontal: 14,
    paddingTop: 8,
    backgroundColor: 'rgba(7,5,11,0.72)',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.06)',
  },
  speakingBar: {
    alignSelf: 'center',
    backgroundColor: 'rgba(255,185,138,0.14)',
    borderWidth: 1,
    borderColor: 'rgba(255,185,138,0.28)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    marginBottom: Spacing.two,
  },
  speakingText: {
    color: Companion.warm,
    fontSize: 12,
    fontWeight: '600',
  },
  toast: {
    textAlign: 'center',
    fontSize: 12,
    marginBottom: Spacing.two,
    color: Companion.textSecondary,
  },
  voiceNotice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Companion.border,
    backgroundColor: Companion.glassStrong,
    paddingHorizontal: 12,
    paddingVertical: 9,
    marginBottom: Spacing.two,
  },
  voiceNoticeText: {
    flex: 1,
    fontSize: 12,
    lineHeight: 17,
    color: Companion.text,
  },
  voiceNoticeAction: {
    color: Companion.accent,
    fontSize: 12,
    fontWeight: '700',
  },
  voiceNoticeClose: {
    fontSize: 16,
    lineHeight: 18,
    color: Companion.textSecondary,
  },
  inputRow: {
    width: '100%',
    maxWidth: 720,
    alignSelf: 'center',
  },
  capsule: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 4,
    padding: 5,
    borderRadius: 27,
    backgroundColor: Companion.glass,
    borderWidth: 1,
    borderColor: Companion.border,
  },
  capsuleRecording: {
    borderColor: 'rgba(255,122,138,0.5)',
  },
  micButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Companion.accentSoft,
  },
  micButtonRecording: {
    backgroundColor: Companion.danger,
  },
  micIcon: {
    fontSize: 15,
    color: '#FFFFFF',
  },
  input: {
    flex: 1,
    minWidth: 0,
    minHeight: 36,
    maxHeight: 104,
    paddingHorizontal: 8,
    paddingTop: Platform.OS === 'web' ? 9 : 8,
    paddingBottom: 8,
    color: Companion.text,
    fontSize: 15,
    lineHeight: 20,
  },
  recordingBody: {
    flex: 1,
    minWidth: 0,
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 6,
  },
  recordingDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: Companion.danger,
  },
  recordingText: {
    fontSize: 13,
    color: Companion.text,
    flexShrink: 0,
    fontVariant: ['tabular-nums'],
  },
  recordingHint: {
    fontSize: 12,
    color: Companion.textSecondary,
    flexShrink: 1,
  },
  sendButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabled: {
    opacity: 0.35,
  },
  sendText: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '700',
  },
  pressed: {
    opacity: 0.7,
  },
});
