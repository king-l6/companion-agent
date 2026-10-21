/**
 * Below are the colors that are used in the app. The colors are defined in the light and dark mode.
 * There are many other ways to style your app. For example, [Nativewind](https://www.nativewind.dev/), [Tamagui](https://tamagui.dev/), [unistyles](https://unistyl.es/), etc.
 */

import '@/global.css';

import { Platform } from 'react-native';

export const Colors = {
  light: {
    text: '#000000',
    background: '#ffffff',
    backgroundElement: '#F0F0F3',
    backgroundSelected: '#E0E1E6',
    textSecondary: '#60646C',
  },
  dark: {
    text: '#F7F1E8',
    background: '#07050B',
    backgroundElement: '#171021',
    backgroundSelected: '#241832',
    textSecondary: 'rgba(247,241,232,0.62)',
  },
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
  borderStrong: 'rgba(255,255,255,0.18)',
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

export type ThemeColor = keyof typeof Colors.light & keyof typeof Colors.dark;

export const Fonts = Platform.select({
  ios: {
    /** iOS `UIFontDescriptorSystemDesignDefault` */
    sans: 'system-ui',
    /** iOS `UIFontDescriptorSystemDesignSerif` */
    serif: 'ui-serif',
    /** iOS `UIFontDescriptorSystemDesignRounded` */
    rounded: 'ui-rounded',
    /** iOS `UIFontDescriptorSystemDesignMonospaced` */
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: 'var(--font-display)',
    serif: 'var(--font-serif)',
    rounded: 'var(--font-rounded)',
    mono: 'var(--font-mono)',
  },
});

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;

export const BottomTabInset = Platform.select({ ios: 50, android: 80 }) ?? 0;
export const MaxContentWidth = 800;
