import AsyncStorage from '@react-native-async-storage/async-storage';

const EVENTS_KEY = 'companion.events.v1';
const MAX_EVENTS = 200;

export type AnalyticsEvent = {
  name: string;
  props: Record<string, unknown>;
  ts: number;
  traceId?: string;
};

type TrackProps = Record<string, unknown> & { traceId?: string };

/**
 * 最小埋点实现：本地 JSONL + 控制台。
 * 真项目里换成统一 SDK，服务端再按事件字典落数仓。
 */
export async function track(name: string, props: TrackProps = {}): Promise<void> {
  const { traceId, ...rest } = props;
  const event: AnalyticsEvent = {
    name,
    props: rest,
    ts: Date.now(),
    traceId: typeof traceId === 'string' ? traceId : undefined,
  };

  console.log(`[analytics] ${name}${traceId ? ` trace=${traceId}` : ''}`, rest);

  try {
    const events = await readEvents();
    events.push(event);
    await AsyncStorage.setItem(EVENTS_KEY, JSON.stringify(events.slice(-MAX_EVENTS)));
  } catch {
    /* 埋点失败不影响主流程 */
  }
}

export async function readEvents(): Promise<AnalyticsEvent[]> {
  try {
    const raw = await AsyncStorage.getItem(EVENTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AnalyticsEvent[]) : [];
  } catch {
    return [];
  }
}

export async function clearEvents(): Promise<void> {
  try {
    await AsyncStorage.removeItem(EVENTS_KEY);
  } catch {
    /* ignore */
  }
}

export function summarize(events: AnalyticsEvent[]) {
  return events.reduce<Record<string, number>>((acc, event) => {
    acc[event.name] = (acc[event.name] ?? 0) + 1;
    return acc;
  }, {});
}
