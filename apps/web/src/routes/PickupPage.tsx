import { useDevice, useDeviceRealtime } from '../components/DeviceGate';

/** ピックアップ端末。注文一覧と呼び出し・受け渡し操作はフェーズ3で実装する */
export function PickupPage() {
  const device = useDevice();
  useDeviceRealtime();
  return (
    <div className="pickup">
      <header className="topbar">
        <strong>{device.name}</strong>
      </header>
      <section className="placeholder">
        <h2>ピックアップ</h2>
        <p>未完了の注文一覧と、呼び出し・受け渡し操作はフェーズ3で実装します。</p>
      </section>
    </div>
  );
}
