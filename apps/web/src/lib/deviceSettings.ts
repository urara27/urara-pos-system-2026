import { useCallback, useEffect, useState } from 'react';
import type { DeviceSettings } from '@pos/shared';
import { api } from './api';

/** 端末用の設定。画面側で settings.updated を受けたら reload を呼ぶ */
export function useDeviceSettings() {
  const [settings, setSettings] = useState<DeviceSettings | null>(null);
  const reload = useCallback(() => {
    api<{ settings: DeviceSettings }>('/api/device-settings')
      .then((res) => setSettings(res.settings))
      .catch(() => undefined);
  }, []);
  useEffect(reload, [reload]);
  return { settings, reload };
}
