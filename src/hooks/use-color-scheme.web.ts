import { useColorScheme as useRNColorScheme } from 'react-native';

/**
 * 本 demo 已固定暗色主题，这里直接透传系统值即可。
 * 之前为静态渲染做的水合占位会在 effect 里同步 setState，触发 lint 报错，也不再需要。
 */
export function useColorScheme() {
  return useRNColorScheme();
}
