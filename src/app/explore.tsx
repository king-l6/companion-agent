import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioRecorder,
} from 'expo-audio';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ACCENT } from '@/components/chat-bubble';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { clearEvents, readEvents, summarize, track, type AnalyticsEvent } from '@/lib/analytics';
import { describeLlm } from '@/lib/llm';
import {
  listChineseVoices,
  pickPreferredVoice,
  resolveVoiceId,
  speak,
  stopSpeaking,
  VOICE_PRESETS,
  type VoiceOption,
  type VoicePreset,
} from '@/lib/speech';
import {
  checkVoiceService,
  extractSpeakers,
  ttsUrl,
  VOICE_SERVICE_URL,
  type ClonedSpeaker,
} from '@/lib/voice-clone';
import {
  clearMessages,
  clearVoiceProfile,
  DEFAULT_VOICE_SETTINGS,
  loadEntitlement,
  loadVoiceProfile,
  loadVoiceSettings,
  saveVoiceProfile,
  saveVoiceSettings,
  type Entitlement,
  DEFAULT_ENTITLEMENT,
  type VoiceProfile,
  type VoiceSettings,
} from '@/lib/storage';

const IMPLEMENTED = [
  '流式对话：配置模型后走真实 SSE，逐 token 刷新，生成中可停止',
  '长列表：FlashList 渲染，长按左上角头像插入 500 条消息压测',
  'TTS 朗读：回复完成后自动朗读；用户一开口立刻打断（barge-in）',
  '音色设置：温柔 / 活泼 / 沉稳三种风格 + 系统中文音色，逐句语速音高起伏，点选即试听，持久化保存',
  '克隆音色：上传音频/视频或直接录音，本地分离说话人，选中角色后聊天用克隆声音逐句朗读',
  '语音输入：Web 用浏览器真实识别，边说边出字，结束后直接发送；空结果可重试',
  '本地会话：AsyncStorage 持久化，冷启动恢复',
  '订阅页：三档套餐、mock 支付、恢复购买、免费 5 条门控',
  '埋点：paywall / purchase / chat / tts / voice 全链路事件',
];

const NEXT = ['接真后端 SSE 与 traceId 透传', '真 ASR / 流式 TTS', '多仓 Agent 自动验收'];

/** 包一层：React Compiler 不会把组件外函数的调用误判成渲染期副作用 */
function nowMs() {
  return Date.now();
}

function formatTime(ts: number) {
  const d = new Date(ts);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export default function AboutScreen() {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const [entitlement, setEntitlement] = useState<Entitlement>(DEFAULT_ENTITLEMENT);
  const [events, setEvents] = useState<AnalyticsEvent[]>([]);
  const [notice, setNotice] = useState('');
  const [voiceSettings, setVoiceSettings] = useState<VoiceSettings>(DEFAULT_VOICE_SETTINGS);
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [voiceLoaded, setVoiceLoaded] = useState(false);

  // 本地克隆音色
  const [voiceProfile, setVoiceProfile] = useState<VoiceProfile | null>(null);
  const [serviceOnline, setServiceOnline] = useState<boolean | null>(null);
  const [clonePhase, setClonePhase] = useState<'idle' | 'extracting'>('idle');
  const [cloneNotice, setCloneNotice] = useState('');
  const [previewingClone, setPreviewingClone] = useState(false);
  const [recordingClone, setRecordingClone] = useState(false);
  const [recordSecs, setRecordSecs] = useState(0);

  const cloneRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const clonePreviewPlayer = useAudioPlayer();
  const clonePollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cloneRecTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cloneRecordStartRef = useRef(0);
  const cloneStoppingRef = useRef(false);
  const recordingCloneRef = useRef(false);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      void (async () => {
        const [savedEntitlement, savedEvents, savedVoice, availableVoices, savedProfile, health] =
          await Promise.all([
            loadEntitlement(),
            readEvents(),
            loadVoiceSettings(),
            listChineseVoices(),
            loadVoiceProfile(),
            checkVoiceService(),
          ]);
        if (!active) return;
        setEntitlement(savedEntitlement);
        setEvents(savedEvents);
        setVoiceSettings(savedVoice);
        setVoices(availableVoices);
        setVoiceLoaded(true);
        setVoiceProfile(savedProfile);
        setServiceOnline(health.online);
      })();
      return () => {
        active = false;
        // 离开页面时停掉试听，避免声音跟着用户跑
        stopSpeaking();
        clonePreviewPlayer.pause();
        setPreviewingClone(false);
        if (clonePollRef.current) clearInterval(clonePollRef.current);
        clonePollRef.current = null;
        if (cloneRecTimerRef.current) clearInterval(cloneRecTimerRef.current);
        cloneRecTimerRef.current = null;
      };
    }, [clonePreviewPlayer])
  );

  const counts = Object.entries(summarize(events)).sort((a, b) => b[1] - a[1]);
  const recent = events.slice(-8).reverse();

  const onClearMessages = async () => {
    await clearMessages();
    setNotice('会话已清空，切回聊天页生效');
  };

  const onClearEvents = async () => {
    await clearEvents();
    setEvents([]);
    setNotice('埋点已清空');
  };

  const applyVoice = async (next: VoiceSettings) => {
    setVoiceSettings(next);
    await saveVoiceSettings(next);
    void track('voice_settings_saved', {
      preset: next.preset,
      voiceId: next.voiceId ?? 'auto',
    });
  };

  const previewVoice = async (settings: VoiceSettings = voiceSettings) => {
    const voiceId = await resolveVoiceId(settings.voiceId);
    speak(
      '你好，我是林夏。今晚的酒馆还亮着灯，要不要进来坐一会儿？',
      {},
      { voice: voiceId, preset: settings.preset }
    );
    void track('voice_preview', {
      preset: settings.preset,
      voiceId: voiceId ?? 'default',
    });
  };

  // 点选后立刻用新音色试听，避免“点了没反应、以为没换”的错觉
  const selectPreset = (preset: VoicePreset) => {
    const next = { ...voiceSettings, preset };
    void applyVoice(next);
    void previewVoice(next);
  };

  const selectVoice = (voiceId: string) => {
    const next = { ...voiceSettings, voiceId };
    void applyVoice(next);
    // 主动点系统音色，说明想用系统声音：把克隆音色的选中状态清掉
    if (voiceProfile?.selectedId) {
      void applyProfile({ ...voiceProfile, selectedId: null });
      setCloneNotice('已切回系统音色');
    }
    void previewVoice(next);
  };

  // ------------------------------------------------------------ 克隆音色

  const applyProfile = async (next: VoiceProfile | null) => {
    setVoiceProfile(next);
    if (next) await saveVoiceProfile(next);
    else await clearVoiceProfile();
  };

  const stopClonePreview = () => {
    clonePreviewPlayer.pause();
    if (clonePollRef.current) clearInterval(clonePollRef.current);
    clonePollRef.current = null;
    setPreviewingClone(false);
  };

  const previewCloned = (speaker: ClonedSpeaker) => {
    stopSpeaking();
    stopClonePreview();
    setPreviewingClone(true);
    setCloneNotice('正在合成试听…');
    clonePreviewPlayer.replace({
      uri: ttsUrl('你好，我是你的新声音。很高兴认识你。', speaker.id),
    });
    clonePreviewPlayer.play();

    // Web 端结束后不一定发状态事件，用轮询兜底
    const startedAt = nowMs();
    clonePollRef.current = setInterval(() => {
      const status = clonePreviewPlayer.currentStatus;
      if (
        status.didJustFinish ||
        status.error ||
        nowMs() - startedAt > 30_000
      ) {
        stopClonePreview();
        setCloneNotice(status.error ? '试听失败，检查本地音色服务是否在运行' : '');
      }
    }, 250);
  };

  const selectCloned = (speaker: ClonedSpeaker) => {
    if (!voiceProfile) return;
    const next = { ...voiceProfile, selectedId: speaker.id };
    void applyProfile(next);
    setCloneNotice(`已选用「${speaker.label}」，聊天回复会用这个音色朗读`);
    void track('voice_clone_selected', {
      speaker: speaker.label,
      seconds: Math.round(speaker.seconds),
    });
    previewCloned(speaker);
  };

  const useSystemVoice = () => {
    if (!voiceProfile) return;
    stopClonePreview();
    void applyProfile({ ...voiceProfile, selectedId: null });
    setCloneNotice('已切回系统音色');
    void track('voice_clone_disabled');
  };

  const removeClone = () => {
    stopClonePreview();
    void applyProfile(null);
    setCloneNotice('克隆音色已移除');
    void track('voice_clone_cleared');
  };

  const uploadClone = async (uri: string, name: string) => {
    setClonePhase('extracting');
    setCloneNotice('');
    stopClonePreview();
    try {
      const result = await extractSpeakers({ uri, name });
      const next: VoiceProfile = {
        jobId: result.jobId,
        duration: result.duration,
        speakers: result.speakers,
        selectedId: result.speakers[0]?.id ?? null,
        sourceName: name,
        createdAt: nowMs(),
      };
      await applyProfile(next);
      setCloneNotice(`分离出 ${result.speakers.length} 个角色，点角色即可试听并选用`);
      void track('voice_clone_extracted', {
        speakers: result.speakers.length,
        sourceSeconds: Math.round(result.duration),
      });
    } catch (error) {
      setCloneNotice(`提取失败：${(error as Error)?.message ?? String(error)}`);
      void track('voice_clone_error', { message: String(error) });
    } finally {
      setClonePhase('idle');
    }
  };

  const pickCloneFile = () => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') {
      setCloneNotice('原生端请直接用「录一段」；导入文件请在 Web 端操作');
      return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'audio/*,video/*';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const url = URL.createObjectURL(file);
      void uploadClone(url, file.name);
    };
    input.click();
  };

  const stopCloneRecording = async () => {
    if (!recordingCloneRef.current || cloneStoppingRef.current) return;
    cloneStoppingRef.current = true;
    recordingCloneRef.current = false;
    setRecordingClone(false);
    if (cloneRecTimerRef.current) clearInterval(cloneRecTimerRef.current);
    cloneRecTimerRef.current = null;

    try {
      await cloneRecorder.stop();
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
      const uri = cloneRecorder.uri;
      if (!uri) throw new Error('没有拿到录音文件');
      await uploadClone(uri, '我的声音.m4a');
    } catch (error) {
      setCloneNotice(`录音失败：${(error as Error)?.message ?? String(error)}`);
    } finally {
      cloneStoppingRef.current = false;
    }
  };

  const startCloneRecording = async () => {
    if (recordingCloneRef.current || clonePhase === 'extracting') return;
    stopClonePreview();
    setCloneNotice('');
    try {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        setCloneNotice('麦克风权限被拒绝，请在浏览器或系统设置里允许后重试');
        return;
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await cloneRecorder.prepareToRecordAsync();
      cloneRecorder.record();
      cloneStoppingRef.current = false;
      cloneRecordStartRef.current = nowMs();
      recordingCloneRef.current = true;
      setRecordingClone(true);
      setRecordSecs(0);

      cloneRecTimerRef.current = setInterval(() => {
        const seconds = Math.floor((Date.now() - cloneRecordStartRef.current) / 1000);
        setRecordSecs(seconds);
        // 30 秒自动结束，避免录太长导致分离变慢
        if (seconds >= 30) void stopCloneRecording();
      }, 250);
    } catch (error) {
      setCloneNotice(`录音启动失败：${(error as Error)?.message ?? String(error)}`);
    }
  };

  // 离开页面时别把录音留在后台
  useEffect(
    () => () => {
      if (cloneRecTimerRef.current) clearInterval(cloneRecTimerRef.current);
      if (clonePollRef.current) clearInterval(clonePollRef.current);
      clonePreviewPlayer.pause();
      if (recordingCloneRef.current) {
        recordingCloneRef.current = false;
        void cloneRecorder.stop().catch(() => {});
      }
    },
    [clonePreviewPlayer, cloneRecorder]
  );

  // 没主动选过时，展示自动挑中的那个，让用户知道实际会用谁
  const activeVoiceId = voiceSettings.voiceId ?? pickPreferredVoice(voices)?.id ?? null;
  const activeVoiceName =
    voices.find((voice) => voice.id === activeVoiceId)?.name ?? '系统默认';

  return (
    <ScrollView
      style={[styles.scrollView, { backgroundColor: theme.background }]}
      contentContainerStyle={[
        styles.content,
        {
          paddingTop: Platform.OS === 'web' ? 92 : insets.top + Spacing.four,
          paddingBottom: BottomTabInset + Spacing.five,
        },
      ]}>
      <ThemedView style={styles.container}>
        <ThemedText type="subtitle">Companion Demo</ThemedText>
        <ThemedText themeColor="textSecondary" style={styles.lead}>
          一个 AI 陪伴叙事 App 的客户端切片。配置模型 Key 后走真实流式对话；
          没配置时自动回退本地 mock，保证离线也能演示。
        </ThemedText>
        <ThemedText type="code" themeColor="textSecondary">
          模型：{describeLlm()}
        </ThemedText>

        <ThemedView type="backgroundElement" style={styles.card}>
          <ThemedText type="smallBold" style={styles.cardTitle}>
            会员状态
          </ThemedText>
          <ThemedText type="small">
            {entitlement.member
              ? `已开通 · ${entitlement.planId} · 积分 ${entitlement.points}`
              : '未开通 · 免费 5 条对话'}
          </ThemedText>
        </ThemedView>

        <ThemedView type="backgroundElement" style={styles.card}>
          <ThemedText type="smallBold" style={styles.cardTitle}>
            已实现
          </ThemedText>
          {IMPLEMENTED.map((item) => (
            <ThemedText key={item} type="small" style={styles.bullet}>
              · {item}
            </ThemedText>
          ))}
        </ThemedView>

        <ThemedView type="backgroundElement" style={styles.card}>
          <ThemedText type="smallBold" style={styles.cardTitle}>
            怎么演示
          </ThemedText>
          <ThemedText type="small" style={styles.bullet}>
            1. 点建议或输入，听回复逐字出现并自动朗读
          </ThemedText>
          <ThemedText type="small" style={styles.bullet}>
            2. 朗读时立刻发下一条，观察 barge-in 打断
          </ThemedText>
          <ThemedText type="small" style={styles.bullet}>
            3. 点顶部「会员 · 剩 5」，走一遍订阅与恢复购买
          </ThemedText>
          <ThemedText type="small" style={styles.bullet}>
            4. 长按头像插入 500 条消息，验证列表滚动
          </ThemedText>
          <ThemedText type="small" style={styles.bullet}>
            5. 点麦克风说一句话，文字边说边出现；点结束直接发送，没听清会提示重试
          </ThemedText>
        </ThemedView>

        <ThemedView type="backgroundElement" style={styles.card}>
          <ThemedText type="smallBold" style={styles.cardTitle}>
            克隆音色（本地）
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            上传一段音频或视频，或者直接录一段。自动分离说话人，选一个角色，聊天就用它朗读。
          </ThemedText>

          <View style={styles.cloneStatus}>
            <View
              style={[
                styles.cloneDot,
                {
                  backgroundColor:
                    serviceOnline === null ? '#999999' : serviceOnline ? '#2ECC71' : '#E74C3C',
                },
              ]}
            />
            <ThemedText type="code" themeColor="textSecondary">
              {serviceOnline === null
                ? '正在检查本地服务…'
                : serviceOnline
                  ? `已连接 ${VOICE_SERVICE_URL}`
                  : '本地服务未启动'}
            </ThemedText>
          </View>

          {serviceOnline === false ? (
            <ThemedText type="code" themeColor="textSecondary" style={styles.voiceFootnote}>
              在项目根目录运行 npm run voice-service，再回到这里；首次启动会加载模型。
            </ThemedText>
          ) : null}

          <View style={styles.voiceRow}>
            <Pressable
              onPress={pickCloneFile}
              disabled={!serviceOnline || clonePhase === 'extracting' || recordingClone}
              accessibilityRole="button"
              accessibilityLabel="上传音频或视频提取音色"
              style={({ pressed }) => [
                styles.voiceChip,
                { backgroundColor: theme.background },
                (!serviceOnline || clonePhase === 'extracting' || recordingClone) &&
                  styles.disabled,
                pressed && styles.pressed,
              ]}>
              <ThemedText type="smallBold">上传音频 / 视频</ThemedText>
              <ThemedText type="code" themeColor="textSecondary">
                mp3 · m4a · wav · mp4
              </ThemedText>
            </Pressable>

            <Pressable
              onPress={() => {
                if (recordingClone) void stopCloneRecording();
                else void startCloneRecording();
              }}
              disabled={!serviceOnline || clonePhase === 'extracting'}
              accessibilityRole="button"
              accessibilityLabel={recordingClone ? '结束录音并提取音色' : '录一段声音做音色'}
              style={({ pressed }) => [
                styles.voiceChip,
                {
                  backgroundColor: recordingClone ? `${ACCENT}22` : theme.background,
                  borderWidth: recordingClone ? StyleSheet.hairlineWidth : 0,
                  borderColor: ACCENT,
                },
                (!serviceOnline || clonePhase === 'extracting') && styles.disabled,
                pressed && styles.pressed,
              ]}>
              <ThemedText type="smallBold" style={recordingClone ? { color: ACCENT } : undefined}>
                {recordingClone ? `结束录音 · ${recordSecs}s` : '录一段'}
              </ThemedText>
              <ThemedText type="code" themeColor="textSecondary">
                {recordingClone ? '建议 10–30 秒' : '对着麦克风说 10–30 秒'}
              </ThemedText>
            </Pressable>
          </View>

          {clonePhase === 'extracting' ? (
            <View style={styles.cloneBusy}>
              <ActivityIndicator size="small" color={ACCENT} />
              <ThemedText type="small" themeColor="textSecondary" style={styles.cloneBusyText}>
                正在抽音轨、分离说话人并识别参考文本，首次会慢一点…
              </ThemedText>
            </View>
          ) : null}

          {previewingClone ? (
            <ThemedText type="code" style={{ color: ACCENT }}>
              试听合成中…
            </ThemedText>
          ) : null}

          {cloneNotice ? (
            <ThemedText type="small" themeColor="textSecondary">
              {cloneNotice}
            </ThemedText>
          ) : null}

          {voiceProfile ? (
            <>
              <View style={styles.voiceHeader}>
                <ThemedText type="small" themeColor="textSecondary" style={styles.flexText}>
                  来自 {voiceProfile.sourceName} · {voiceProfile.duration.toFixed(1)}s ·{' '}
                  {voiceProfile.speakers.length} 个角色
                </ThemedText>
                <Pressable
                  onPress={useSystemVoice}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="切回系统音色">
                  <ThemedText type="small" style={styles.voiceAction}>
                    用系统音色
                  </ThemedText>
                </Pressable>
              </View>

              <View style={styles.voiceList}>
                {voiceProfile.speakers.map((speaker) => {
                  const active = voiceProfile.selectedId === speaker.id;
                  return (
                    <Pressable
                      key={speaker.id}
                      onPress={() => selectCloned(speaker)}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                      accessibilityLabel={`克隆音色 ${speaker.label}，试听并选用`}
                      style={({ pressed }) => [
                        styles.voiceItem,
                        {
                          backgroundColor: active ? `${ACCENT}18` : theme.background,
                          borderColor: active ? ACCENT : 'transparent',
                        },
                        pressed && styles.pressed,
                      ]}>
                      <View style={styles.voiceInfo}>
                        <ThemedText type="small" numberOfLines={1}>
                          {speaker.label} · 说话 {Math.round(speaker.seconds)}s · 参考{' '}
                          {speaker.clipSeconds.toFixed(1)}s
                        </ThemedText>
                        <ThemedText
                          type="code"
                          themeColor="textSecondary"
                          numberOfLines={2}>
                          {speaker.referenceText || '参考文本识别为空，仍可试听'}
                        </ThemedText>
                      </View>
                      <ThemedText type="small" style={styles.voiceAction}>
                        {active ? '✓' : '试听'}
                      </ThemedText>
                    </Pressable>
                  );
                })}
              </View>

              <View style={styles.cloneFooter}>
                <ThemedText type="code" themeColor="textSecondary">
                  {voiceProfile.selectedId ? '聊天会使用选中的克隆音色' : '当前使用系统音色'}
                </ThemedText>
                <Pressable
                  onPress={removeClone}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="移除克隆音色">
                  <ThemedText type="code" themeColor="textSecondary" style={styles.cloneRemove}>
                    移除
                  </ThemedText>
                </Pressable>
              </View>
            </>
          ) : null}

          <ThemedText type="code" themeColor="textSecondary" style={styles.voiceFootnote}>
            音视频只发到本机 {VOICE_SERVICE_URL}，不上传云端。参考片段 3–15 秒、背景干净时最像；
            多人素材会自动拆成多个角色供选择。
          </ThemedText>
        </ThemedView>

        <ThemedView type="backgroundElement" style={styles.card}>
          <ThemedText type="smallBold" style={styles.cardTitle}>
            声音
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            说话风格（语速 / 音高，逐句有起伏）
          </ThemedText>
          <View style={styles.voiceRow}>
            {(Object.keys(VOICE_PRESETS) as VoicePreset[]).map((preset) => {
              const active = voiceSettings.preset === preset;
              return (
                <Pressable
                  key={preset}
                  onPress={() => selectPreset(preset)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={`声音风格 ${VOICE_PRESETS[preset].label}`}
                  style={({ pressed }) => [
                    styles.voiceChip,
                    { backgroundColor: active ? ACCENT : theme.background },
                    pressed && styles.pressed,
                  ]}>
                  <ThemedText
                    type="smallBold"
                    style={{ color: active ? '#FFFFFF' : theme.text }}>
                    {VOICE_PRESETS[preset].label}
                  </ThemedText>
                  <ThemedText
                    type="code"
                    style={{ color: active ? '#FFFFFFCC' : theme.textSecondary }}>
                    {VOICE_PRESETS[preset].hint}
                  </ThemedText>
                </Pressable>
              );
            })}
          </View>

          <View style={styles.voiceHeader}>
            <ThemedText type="small" themeColor="textSecondary">
              系统中文音色 · 当前 {activeVoiceName}
            </ThemedText>
            <Pressable
              onPress={() => void previewVoice()}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="试听当前声音">
              <ThemedText type="small" style={styles.voiceAction}>
                试听
              </ThemedText>
            </Pressable>
          </View>

          {!voiceLoaded ? (
            <ThemedText type="small" themeColor="textSecondary">
              正在读取本机音色…
            </ThemedText>
          ) : voices.length === 0 ? (
            <ThemedText type="small" themeColor="textSecondary">
              当前环境没有列出中文音色，会使用系统默认语音；可以先用上面的三种风格。
            </ThemedText>
          ) : (
            <View style={styles.voiceList}>
              {voices.map((voice) => {
                const active = activeVoiceId === voice.id;
                return (
                  <Pressable
                    key={voice.id}
                    onPress={() => selectVoice(voice.id)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    accessibilityLabel={`音色 ${voice.name}`}
                    style={({ pressed }) => [
                      styles.voiceItem,
                      {
                        backgroundColor: active ? `${ACCENT}18` : theme.background,
                        borderColor: active ? ACCENT : 'transparent',
                      },
                      pressed && styles.pressed,
                    ]}>
                    <View style={styles.voiceInfo}>
                      <ThemedText type="small" numberOfLines={1}>
                        {voice.name}
                      </ThemedText>
                      <ThemedText type="code" themeColor="textSecondary">
                        {voice.language}
                        {voice.quality ? ` · ${voice.quality}` : ''}
                      </ThemedText>
                    </View>
                    {active ? (
                      <ThemedText type="small" style={styles.voiceAction}>
                        ✓
                      </ThemedText>
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
          )}

          <ThemedText type="code" themeColor="textSecondary" style={styles.voiceFootnote}>
            点任意音色或风格会立刻试听；音色作用于本机系统 TTS，换设备后不存在会自动回退到默认中文女声。
          </ThemedText>
        </ThemedView>

        <ThemedView type="backgroundElement" style={styles.card}>
          <ThemedText type="smallBold" style={styles.cardTitle}>
            埋点调试（{events.length} 条）
          </ThemedText>
          {counts.length === 0 ? (
            <ThemedText type="small" themeColor="textSecondary">
              还没有事件。发一条消息或打开订阅页试试。
            </ThemedText>
          ) : (
            <ThemedText type="small" style={styles.bullet}>
              {counts.map(([name, count]) => `${name} ${count}`).join(' · ')}
            </ThemedText>
          )}
          {recent.map((event, index) => (
            <ThemedText
              key={`${event.ts}-${index}`}
              type="code"
              themeColor="textSecondary"
              style={styles.eventLine}>
              {formatTime(event.ts)} {event.name}
              {event.traceId ? ` ${event.traceId}` : ''}
            </ThemedText>
          ))}
        </ThemedView>

        <ThemedView type="backgroundElement" style={styles.card}>
          <ThemedText type="smallBold" style={styles.cardTitle}>
            接真后端
          </ThemedText>
          <ThemedText type="small" style={styles.bullet}>
            推荐用 npm run llm-proxy 把真实 Key 留在本地代理，客户端在 .env.local 指向
            {` http://127.0.0.1:8099 `}；OpenAI 兼容网关和 Claude 协议都支持。
          </ThemedText>
          <ThemedText type="small" style={styles.bullet}>
            配了 EXPO_PUBLIC_ASR_URL 后 Web 和原生都走录音上传识别（multipart，返回{' '}
            {'{ "text": "..." }'}）；否则 Web 用浏览器识别、原生回退 mock。
          </ThemedText>
        </ThemedView>

        <ThemedView style={styles.actions}>
          <Pressable
            onPress={onClearMessages}
            style={({ pressed }) => [
              styles.actionButton,
              { backgroundColor: theme.backgroundElement },
              pressed && styles.pressed,
            ]}>
            <ThemedText type="small">清空会话</ThemedText>
          </Pressable>
          <Pressable
            onPress={onClearEvents}
            style={({ pressed }) => [
              styles.actionButton,
              { backgroundColor: theme.backgroundElement },
              pressed && styles.pressed,
            ]}>
            <ThemedText type="small">清空埋点</ThemedText>
          </Pressable>
        </ThemedView>

        {notice ? (
          <ThemedText type="small" themeColor="textSecondary" style={styles.notice}>
            {notice}
          </ThemedText>
        ) : null}

        <ThemedView type="backgroundElement" style={styles.card}>
          <ThemedText type="smallBold" style={styles.cardTitle}>
            下一步
          </ThemedText>
          {NEXT.map((item) => (
            <ThemedText key={item} type="small" style={styles.bullet}>
              · {item}
            </ThemedText>
          ))}
        </ThemedView>

        <ThemedText type="code" themeColor="textSecondary" style={styles.footer}>
          Expo SDK 58 · RN 0.88 · FlashList 2
        </ThemedText>
      </ThemedView>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scrollView: {
    flex: 1,
  },
  content: {
    flexDirection: 'row',
    justifyContent: 'center',
    paddingHorizontal: Spacing.three,
  },
  container: {
    width: '100%',
    maxWidth: MaxContentWidth,
    gap: Spacing.three,
  },
  lead: {
    marginBottom: Spacing.two,
  },
  card: {
    borderRadius: Spacing.three,
    padding: Spacing.three,
    gap: Spacing.one,
  },
  cardTitle: {
    marginBottom: Spacing.one,
  },
  bullet: {
    lineHeight: 22,
  },
  voiceRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
    marginTop: Spacing.one,
  },
  voiceChip: {
    flexGrow: 1,
    minWidth: 100,
    alignItems: 'center',
    gap: 2,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.two,
    borderRadius: Spacing.two,
  },
  voiceHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: Spacing.two,
  },
  voiceAction: {
    color: ACCENT,
    fontWeight: '700',
  },
  voiceList: {
    gap: Spacing.one,
    marginTop: Spacing.one,
  },
  voiceItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    borderRadius: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.two,
  },
  voiceInfo: {
    flex: 1,
    minWidth: 0,
  },
  voiceFootnote: {
    marginTop: Spacing.one,
    lineHeight: 16,
  },
  eventLine: {
    fontSize: 11,
    lineHeight: 18,
  },
  actions: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  actionButton: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: Spacing.two,
    borderRadius: Spacing.two,
  },
  notice: {
    textAlign: 'center',
  },
  pressed: {
    opacity: 0.7,
  },
  disabled: {
    opacity: 0.45,
  },
  cloneStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    marginTop: Spacing.one,
  },
  cloneDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  cloneBusy: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    marginTop: Spacing.one,
  },
  cloneBusyText: {
    flex: 1,
  },
  cloneFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: Spacing.one,
  },
  cloneRemove: {
    color: '#E74C3C',
  },
  flexText: {
    flex: 1,
  },
  footer: {
    textAlign: 'center',
    paddingTop: Spacing.two,
  },
});
