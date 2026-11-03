/**
 * 効果音。外部ファイルに頼らず Web Audio で合成する（オフライン・CDN 不使用）。
 * iPad 等は自動再生が制限されるので、ユーザーのタップ中に unlock() を呼んで有効にする。
 */
let ctx: AudioContext | null = null;

export async function unlockAudio(): Promise<boolean> {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') await ctx.resume();
    // 無音を1回鳴らして iOS の制限を解除する
    const buffer = ctx.createBuffer(1, 1, 22050);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start();
    return ctx.state === 'running';
  } catch {
    return false;
  }
}

export function isAudioUnlocked() {
  return ctx?.state === 'running';
}

function tone(frequency: number, startAt: number, duration: number, volume = 0.3) {
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = frequency;
  gain.gain.setValueAtTime(0, startAt);
  gain.gain.linearRampToValueAtTime(volume, startAt + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.001, startAt + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start(startAt);
  osc.stop(startAt + duration);
}

/** 呼び出しチャイム（ピンポーン） */
export function playChime() {
  if (!ctx || ctx.state !== 'running') return;
  const t = ctx.currentTime;
  tone(880, t, 0.6);
  tone(698.46, t + 0.45, 0.9);
}

/** 新規注文の通知音（短い2音） */
export function playNotify() {
  if (!ctx || ctx.state !== 'running') return;
  const t = ctx.currentTime;
  tone(1046.5, t, 0.15, 0.25);
  tone(1318.5, t + 0.15, 0.25, 0.25);
}
