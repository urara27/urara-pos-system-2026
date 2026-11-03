import { useEffect } from 'react';
import { create } from 'zustand';

interface ToastState {
  message: string | null;
  key: number;
  show: (message: string) => void;
  clear: () => void;
}

export const useToast = create<ToastState>((set) => ({
  message: null,
  key: 0,
  show: (message) => set((s) => ({ message, key: s.key + 1 })),
  clear: () => set({ message: null }),
}));

export function Toast() {
  const { message, key, clear } = useToast();
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(clear, 4000);
    return () => clearTimeout(timer);
  }, [message, key, clear]);
  if (!message) return null;
  return (
    <div className="toast" role="status" onClick={clear}>
      {message}
    </div>
  );
}
