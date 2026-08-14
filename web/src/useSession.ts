import { useEffect, useState } from 'react';
import type { User } from './types';

export type Session = { token: string; user: User };

const STORAGE_KEY = 'doelenboom.session';

// Gedeeld tussen App.tsx en losse URL-routes zoals DbStatPage.tsx (/dbstat) —
// zelfde localStorage-sleutel, zelfde validatie, zodat een al ingelogde
// sysadmin die rechtstreeks naar /dbstat navigeert niet opnieuw hoeft in te
// loggen, en een sessie van vóór een schema-wijziging (ontbrekende velden)
// overal op dezelfde manier als "ongeldig" behandeld wordt i.p.v. een crash.
export function useSession() {
  const [session, setSession] = useState<Session | null>(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Session;
      if (
        !parsed?.user ||
        typeof parsed.user.isSysadmin !== 'boolean' ||
        typeof parsed.user.mustChangePassword !== 'boolean' ||
        !Array.isArray(parsed.user.tenantRoles)
      ) {
        localStorage.removeItem(STORAGE_KEY);
        return null;
      }
      return parsed;
    } catch {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
  });

  useEffect(() => {
    if (session) localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else localStorage.removeItem(STORAGE_KEY);
  }, [session]);

  return { session, setSession };
}
