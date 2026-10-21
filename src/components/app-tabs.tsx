import { NativeTabs } from 'expo-router/native-tabs';

import { Companion } from '@/constants/theme';

export default function AppTabs() {
  return (
    <NativeTabs
      backgroundColor={Companion.background}
      indicatorColor="rgba(201,167,255,0.16)"
      labelStyle={{ selected: { color: Companion.text } }}>
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Label>聊天</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          src={require('@/assets/images/tabIcons/home.png')}
          renderingMode="template"
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="explore">
        <NativeTabs.Trigger.Label>说明</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          src={require('@/assets/images/tabIcons/explore.png')}
          renderingMode="template"
        />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
