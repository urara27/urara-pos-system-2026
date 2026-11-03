import { useState } from 'react';
import { useDeviceRealtime } from '../components/DeviceGate';
import { useWakeLock } from '../lib/hooks';
import { playChime, unlockAudio } from '../lib/sound';

/**
 * カスタマーモニター。操作不要の全画面表示。
 * 音声の自動再生制限に対応するため、起動時に一度タップしてもらう（要件3.4）。
 * 番号の表示はフェーズ3で実装する。
 */
export function CustomerPage() {
  const [started, setStarted] = useState(false);
  useWakeLock(started);
  useDeviceRealtime();

  const start = async () => {
    await unlockAudio();
    playChime();
    // キオスク表示を前提に、可能なら全画面にする
    await document.documentElement.requestFullscreen?.().catch(() => undefined);
    setStarted(true);
  };

  if (!started) {
    return (
      <button className="tap-to-start" onClick={start}>
        <span className="tap-to-start__title">画面をタップして開始</span>
        <span className="tap-to-start__sub">呼び出しチャイムを鳴らすために必要です</span>
      </button>
    );
  }

  return (
    <div className="customer">
      <section className="customer__area customer__area--preparing">
        <h2>おつくり中</h2>
        <div className="customer__numbers" />
      </section>
      <section className="customer__area customer__area--calling">
        <h2>お呼び出し中</h2>
        <div className="customer__numbers" />
      </section>
    </div>
  );
}
