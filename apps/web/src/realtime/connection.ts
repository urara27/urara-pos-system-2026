import { useEffect, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';
import { create } from 'zustand';
import type {
  ClientToServerEvents,
  EventEnvelope,
  HelloPayload,
  ServerToClientEvents,
} from '@pos/shared';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'unauthorized';

interface ConnectionState {
  status: ConnectionStatus;
  /** サーバーとの時刻差（サーバー時刻 - 端末時刻, ms）。経過時間表示はサーバー時刻を正とする */
  clockOffsetMs: number;
  set: (patch: Partial<Omit<ConnectionState, 'set'>>) => void;
}

export const useConnection = create<ConnectionState>((set) => ({
  status: 'connecting',
  clockOffsetMs: 0,
  set: (patch) => set(patch),
}));

export type PosSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

type Handlers = Partial<{
  [E in keyof ServerToClientEvents]: ServerToClientEvents[E];
}>;

interface UseRealtimeOptions {
  /** null の間は接続しない */
  auth: { deviceToken: string } | { adminSession: string } | null;
  /**
   * 接続・再接続のたびに呼ばれる。ここで必要な全状態を REST で取り直し、
   * 切断中に取りこぼしたイベントを補う。
   */
  onSync?: (hello: EventEnvelope<HelloPayload>) => void;
  handlers?: Handlers;
}

/** Socket.IO 接続を張り、通信状態をストアに反映する。切断時は自動で再接続する */
export function useRealtime({ auth, onSync, handlers = {} }: UseRealtimeOptions) {
  const setState = useConnection((s) => s.set);
  // ハンドラは毎レンダーで変わり得るので ref 経由で最新を呼ぶ
  const latest = useRef({ onSync, handlers });
  latest.current = { onSync, handlers };
  const authKey = auth ? JSON.stringify(auth) : null;

  useEffect(() => {
    if (!authKey) return;
    const socket: PosSocket = io({
      auth: JSON.parse(authKey) as Record<string, string>,
      transports: ['websocket'],
      reconnectionDelay: 500,
      reconnectionDelayMax: 3000,
    });
    setState({ status: 'connecting' });

    socket.on('connect', () => setState({ status: 'connected' }));
    socket.on('disconnect', () => setState({ status: 'disconnected' }));
    socket.on('connect_error', (err) => {
      setState({ status: err.message === 'unauthorized' ? 'unauthorized' : 'disconnected' });
    });
    socket.on('system.hello', (hello) => {
      setState({ clockOffsetMs: hello.payload.serverTime - Date.now() });
      latest.current.onSync?.(hello);
    });

    // system.hello 以外のイベントは画面ごとのハンドラへ渡す
    socket.onAny((event: string, envelope: unknown) => {
      if (event === 'system.hello') return;
      const handler = latest.current.handlers[event as keyof Handlers] as ((e: unknown) => void) | undefined;
      handler?.(envelope);
    });

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
    };
  }, [authKey, setState]);
}
