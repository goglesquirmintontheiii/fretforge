import { useEffect, useState } from 'react';
import type { StatusResponse } from '@fretforge/shared';
import { api } from './api';
import { AppProvider, go, useRoute } from './lib/app';
import { TopBar } from './components/TopBar';
import { LibraryView } from './components/LibraryView';
import { SearchView } from './components/SearchView';
import { SettingsView } from './components/SettingsView';
import { SongView } from './player/SongView';
import { AuthScreen } from './components/AuthScreen';

export function App() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => api.status().then(setStatus).catch((e) => setError(e.message));
  useEffect(() => { refresh(); }, []);

  if (error) return <div className="authwrap"><div className="card authcard"><h2>Fretforge can’t start</h2><p className="error">{error}</p><button className="btn" onClick={() => location.reload()}>Try again</button></div></div>;
  if (!status) return <div className="authwrap"><span className="spinner" aria-label="Loading" /></div>;
  if (status.mode === 'server' && (status.needsSetup || !status.authenticated)) return <AuthScreen setup={status.needsSetup} onDone={refresh} />;

  return (
    <AppProvider mode={status.mode} version={status.version}>
      <Shell />
    </AppProvider>
  );
}

function Shell() {
  const route = useRoute();
  useEffect(() => {
    if (route.name !== 'song') document.title = 'Fretforge';
  }, [route]);
  return (
    <div className="shell">
      <TopBar route={route} />
      <main className="main" id="main">
        {route.name === 'library' && <LibraryView />}
        {route.name === 'search' && <SearchView q={route.q} />}
        {route.name === 'settings' && <SettingsView />}
        {route.name === 'song' && <SongView key={route.id} id={route.id} onClose={() => (history.length > 1 ? history.back() : go('/'))} />}
      </main>
    </div>
  );
}
