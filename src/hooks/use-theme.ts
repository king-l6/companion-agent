/**
 * 这个 demo 是沉浸式暗色陪伴场景，不跟随系统明暗。
 * 统一返回暗色色板，保证聊天、订阅页、说明页的观感一致。
 */

import { Colors } from '@/constants/theme';

export function useTheme() {
  return Colors;
}
