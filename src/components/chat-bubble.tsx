import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Companion } from '@/constants/theme';
import type { ChatMessage } from '@/lib/chat';

export const ACCENT = Companion.accent;

type Props = {
  message: ChatMessage;
  onSpeak?: () => void;
};

/**
 * 沉浸式气泡：角色台词压在背景图的半透明底衬上，用户消息用右侧紫调玻璃气泡。
 * 不显示头像，角色身份由顶栏承担，避免打断画面。
 */
export const ChatBubble = memo(function ChatBubble({ message, onSpeak }: Props) {
  const isUser = message.role === 'user';
  const isTyping = message.status === 'streaming' && message.content.length === 0;
  const canSpeak = !isUser && !!onSpeak && message.content.length > 0;

  const bubble = (
    <View style={[styles.bubble, isUser ? styles.userBubble : styles.assistantBubble]}>
      <Text style={[styles.text, isUser ? styles.userText : styles.assistantText]}>
        {isTyping ? '···' : message.content}
        {message.status === 'streaming' && !isTyping ? (
          <Text style={styles.cursor}>▍</Text>
        ) : null}
      </Text>
    </View>
  );

  return (
    <View style={[styles.row, isUser ? styles.rowUser : styles.rowAssistant]}>
      <View style={styles.column}>
        {canSpeak ? (
          <Pressable
            onPress={onSpeak}
            accessibilityRole="button"
            accessibilityLabel="朗读这条回复"
            style={({ pressed }) => pressed && styles.pressed}>
            {bubble}
          </Pressable>
        ) : (
          bubble
        )}

        {message.status === 'stopped' && <Text style={styles.meta}>已停止生成</Text>}
        {message.status === 'error' && (
          <Text style={[styles.meta, styles.error]}>生成失败，请重试</Text>
        )}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    paddingHorizontal: 18,
    marginBottom: 16,
  },
  rowUser: {
    justifyContent: 'flex-end',
  },
  rowAssistant: {
    justifyContent: 'flex-start',
  },
  column: {
    maxWidth: '84%',
  },
  bubble: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 20,
  },
  userBubble: {
    backgroundColor: Companion.userBubble,
    borderWidth: 1,
    borderColor: Companion.userBubbleBorder,
    borderBottomRightRadius: 6,
  },
  assistantBubble: {
    backgroundColor: Companion.panel,
    borderWidth: 1,
    borderColor: Companion.border,
    borderBottomLeftRadius: 6,
  },
  text: {
    fontSize: 15,
    lineHeight: 24,
  },
  userText: {
    color: '#FFFFFF',
  },
  assistantText: {
    color: Companion.text,
  },
  cursor: {
    color: Companion.accent,
  },
  meta: {
    fontSize: 11,
    marginTop: 5,
    marginLeft: 4,
    color: Companion.textTertiary,
  },
  error: {
    color: Companion.danger,
  },
  pressed: {
    opacity: 0.75,
  },
});
