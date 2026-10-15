/** Deployment source: copy to agent-frontend/src/pages/DesktopHostPage.tsx.
 * Copy host/runtime.ts and src/shared/types.ts to src/desktop-host/runtime.ts and types.ts;
 * change runtime's type import to './types'.
 */
import React, { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import apiClient from '../services/apiClient';
import { useAuthStore } from '../stores/authStore';
import { mountDesktopHost } from '../desktop-host/runtime';

export default function DesktopHostPage() {
  const root = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  useEffect(() => {
    if (!root.current) return;
    return mountDesktopHost(root.current, {
      post: async (path, body, signal) => (await apiClient.post(path, body, { signal })).data,
      session: () => {
        const state = useAuthStore.getState();
        return { authenticated: state.isAuthenticated && !state.sessionEnding, accountScope: state.agent ? `psim:${state.agent.id}` : null, sessionRef: state.sessionRef, permissions: state.agent?.permissions ?? [] };
      },
      subscribe: listener => useAuthStore.subscribe(listener),
      validate: async () => { await useAuthStore.getState().refreshAgent(); },
      logout: () => useAuthStore.getState().logout(),
      navigateLogin: () => navigate('/login', { state: { returnTo: { pathname: '/desktop-host', search: '', hash: '' } } }),
      // Only set true in a reviewed site release after restricted-account/backend denial tests.
      operatorReadOnlyVerified: false,
    });
  }, [navigate]);
  return <div ref={root} />;
}
