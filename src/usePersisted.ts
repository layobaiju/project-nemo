import { useEffect, useState } from 'react';

/** Per-device UI preference (layers, basemap, device mode). Falls back silently when storage is blocked. */
export function usePersisted<T>(key: string, initial: T): [T, (v: T | ((x: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try { const raw = localStorage.getItem(key); return raw ? (JSON.parse(raw) as T) : initial; } catch { return initial; }
  });
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} }, [key, value]);
  return [value, setValue];
}
