import { useEffect, useState } from 'react';
import { SessionItem } from '../types';

export function useSessions(apiUrl: string) {
  const [sessions, setSessions] = useState<SessionItem[]>([]);

  useEffect(() => {
    async function loadSessions() {
      try {
        const res = await fetch(`${apiUrl}/api/sessions`);
        const json = await res.json();
        const items = (json?.items ?? []) as SessionItem[];
        setSessions(items);
      } catch (e) {
        // ignore
      }
    }
    loadSessions();
    const interval = setInterval(loadSessions, 5000);
    return () => clearInterval(interval);
  }, [apiUrl]);

  return sessions;
}

