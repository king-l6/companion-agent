import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ACCENT } from '@/components/chat-bubble';
import { Companion, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { track } from '@/lib/analytics';
import {
  loadEntitlement,
  saveEntitlement,
  type Entitlement,
  type PlanId,
} from '@/lib/storage';

type Plan = {
  id: PlanId;
  name: string;
  price: number;
  days: number;
  points: number;
  tag?: string;
};

const PLANS: Plan[] = [
  { id: 'week', name: '周卡', price: 18, days: 7, points: 60 },
  { id: 'month', name: '月卡', price: 68, days: 30, points: 300, tag: '最受欢迎' },
  { id: 'year', name: '年卡', price: 328, days: 365, points: 2400, tag: '省 55%' },
];

const BENEFITS = ['无限对话次数', '语音朗读与打断', '每月赠送积分', '角色专属剧情'];

/** 只格式化已有的到期时间戳，不在渲染里读当前时间 */
function formatExpiry(ts: number) {
  const d = new Date(ts);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
}

type Props = {
  visible: boolean;
  entitlement: Entitlement;
  onClose: () => void;
  onPurchased: (entitlement: Entitlement) => void;
};

export function PaywallSheet({ visible, entitlement, onClose, onPurchased }: Props) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [selected, setSelected] = useState<PlanId>('month');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (visible) void track('paywall_view', { member: entitlement.member });
  }, [visible, entitlement.member]);

  const plan = PLANS.find((item) => item.id === selected) ?? PLANS[1];

  const close = () => {
    setMessage('');
    setBusy(false);
    onClose();
  };

  const purchase = async () => {
    if (busy) return;
    setBusy(true);
    setMessage('');
    await track('purchase_start', { planId: plan.id, price: plan.price });

    // mock 支付：真项目里这里是 StoreKit / Google Play Billing
    await new Promise((resolve) => setTimeout(resolve, 800));

    const next: Entitlement = {
      member: true,
      planId: plan.id,
      expiresAt: Date.now() + plan.days * 24 * 60 * 60 * 1000,
      points: entitlement.points + plan.points,
    };
    await saveEntitlement(next);
    await track('purchase_success', {
      planId: plan.id,
      price: plan.price,
      points: next.points,
    });
    onPurchased(next);
    setBusy(false);
    setMessage('开通成功，权益已到账');
    setTimeout(close, 700);
  };

  const restore = async () => {
    if (busy) return;
    setBusy(true);
    const saved = await loadEntitlement();
    if (saved.member) {
      await track('restore_success', { planId: saved.planId });
      onPurchased(saved);
      setMessage('已恢复购买');
      setTimeout(close, 700);
    } else {
      await track('restore_empty');
      setMessage('没有找到可恢复的购买');
    }
    setBusy(false);
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
      <View style={styles.root}>
        <Pressable style={styles.backdrop} onPress={close} />

        <View
          style={[
            styles.sheet,
            {
              backgroundColor: Companion.background,
              paddingBottom: insets.bottom + Spacing.three,
            },
          ]}>
          <View style={[styles.handle, { backgroundColor: 'rgba(255,255,255,0.16)' }]} />

          <ScrollView showsVerticalScrollIndicator={false}>
            <Text style={[styles.title, { color: theme.text }]}>林夏的会员</Text>
            <Text style={[styles.subtitle, { color: theme.textSecondary }]}>
              {entitlement.member
                ? `已开通 · 有效期至 ${
                    entitlement.expiresAt ? formatExpiry(entitlement.expiresAt) : '—'
                  }`
                : '解锁无限对话、语音陪伴与专属剧情'}
            </Text>

            <View style={styles.plans}>
              {PLANS.map((item) => {
                const active = item.id === selected;
                return (
                  <Pressable
                    key={item.id}
                    onPress={() => {
                      setSelected(item.id);
                      void track('plan_select', { planId: item.id });
                    }}
                    style={[
                      styles.planCard,
                      {
                        backgroundColor: active
                          ? 'rgba(201,167,255,0.14)'
                          : 'rgba(23,16,33,0.82)',
                        borderColor: active ? ACCENT : Companion.border,
                      },
                    ]}>
                    {item.tag ? (
                      <View style={styles.tag}>
                        <Text style={styles.tagText}>{item.tag}</Text>
                      </View>
                    ) : null}
                    <Text style={[styles.planName, { color: theme.text }]}>{item.name}</Text>
                    <Text style={[styles.planPrice, { color: theme.text }]}>¥{item.price}</Text>
                    <Text style={[styles.planPoints, { color: theme.textSecondary }]}>
                      +{item.points} 积分
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <View style={styles.benefits}>
              {BENEFITS.map((benefit) => (
                <View key={benefit} style={styles.benefitRow}>
                  <Text style={styles.check}>✓</Text>
                  <Text style={[styles.benefitText, { color: theme.text }]}>{benefit}</Text>
                </View>
              ))}
            </View>

            <Pressable
              onPress={purchase}
              disabled={busy}
              style={({ pressed }) => [
                busy && styles.disabled,
                pressed && styles.pressed,
              ]}>
              <LinearGradient
                colors={Companion.gradient}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.cta}>
                {busy ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.ctaText}>¥{plan.price} 开通{plan.name}</Text>
                )}
              </LinearGradient>
            </Pressable>

            <Pressable onPress={restore} disabled={busy} style={styles.restore}>
              <Text style={[styles.restoreText, { color: theme.textSecondary }]}>恢复购买</Text>
            </Pressable>

            {message ? (
              <Text style={[styles.message, { color: ACCENT }]}>{message}</Text>
            ) : null}

            <Text style={[styles.legal, { color: theme.textSecondary }]}>
              mock 支付，不会产生真实扣款。真项目里由客户端发起 StoreKit / Google Play
              Billing，服务端校验收据后下发权益。
            </Text>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  sheet: {
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: Companion.border,
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.two,
    maxHeight: '88%',
  },
  handle: {
    width: 38,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: Spacing.three,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
  },
  subtitle: {
    fontSize: 13,
    marginTop: 4,
    marginBottom: Spacing.four,
  },
  plans: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  planCard: {
    flex: 1,
    borderRadius: 16,
    borderWidth: 1.5,
    paddingVertical: Spacing.three,
    alignItems: 'center',
  },
  tag: {
    position: 'absolute',
    top: -10,
    backgroundColor: ACCENT,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  tagText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
  },
  planName: {
    fontSize: 13,
    fontWeight: '600',
  },
  planPrice: {
    fontSize: 20,
    fontWeight: '700',
    marginTop: 6,
  },
  planPoints: {
    fontSize: 11,
    marginTop: 2,
  },
  benefits: {
    marginTop: Spacing.four,
    gap: Spacing.two,
  },
  benefitRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  check: {
    color: Companion.warm,
    fontWeight: '700',
  },
  benefitText: {
    fontSize: 14,
  },
  cta: {
    marginTop: Spacing.four,
    borderRadius: 25,
    height: 50,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctaText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  disabled: {
    opacity: 0.6,
  },
  pressed: {
    opacity: 0.8,
  },
  restore: {
    alignItems: 'center',
    paddingVertical: Spacing.three,
  },
  restoreText: {
    fontSize: 13,
  },
  message: {
    textAlign: 'center',
    fontSize: 13,
    marginBottom: Spacing.two,
  },
  legal: {
    fontSize: 11,
    lineHeight: 17,
    textAlign: 'center',
    marginBottom: Spacing.two,
  },
});
