import '@/global.css';

import { Platform } from 'react-native';

/** 固定暗色主题的基础色板。 */
export const Colors = {
  text: '#F7F1E8',
  background: '#07050B',
  backgroundElement: '#171021',
  textSecondary: 'rgba(247,241,232,0.62)',
} as const;

/**
 * 沉浸式陪伴场景的固定色板。
 * 聊天页不跟随系统明暗：暗色背景图 + 暖色轮廓光才是这个产品的基调。
 */
export const Companion = {
  background: '#07050B',
  text: '#F7F1E8',
  textSecondary: 'rgba(247,241,232,0.62)',
  textTertiary: 'rgba(247,241,232,0.40)',
  /** 半透明玻璃面板，用于顶栏按钮、输入胶囊 */
  glass: 'rgba(18,12,28,0.62)',
  glassStrong: 'rgba(14,9,22,0.86)',
  /** 角色消息的底衬，比用户气泡更轻 */
  panel: 'rgba(10,7,16,0.42)',
  border: 'rgba(255,255,255,0.10)',
  accent: '#C9A7FF',
  accentSoft: 'rgba(201,167,255,0.18)',
  userBubble: 'rgba(132,88,196,0.40)',
  userBubbleBorder: 'rgba(210,185,255,0.30)',
  warm: '#FFB98A',
  online: '#8CE0B7',
  danger: '#FF7A8A',
  /** 主行动按钮 / 选中态的紫粉渐变 */
  gradient: ['#B16CEA', '#FF8FB1'] as [string, string],
} as const;

export type ThemeColor = keyof typeof Colors;

export const Fonts = Platform.select({
  ios: {
    /** iOS `UIFontDescriptorSystemDesignMonospaced` */
    mono: 'ui-monospace',
  },
  default: {
    mono: 'monospace',
  },
  web: {
    mono: 'var(--font-mono)',
  },
});

export const Spacing = {
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
} as const;

export const BottomTabInset = Platform.select({ ios: 50, android: 80 }) ?? 0;
export const MaxContentWidth = 800;
