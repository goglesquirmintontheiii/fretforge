import { lazy, Suspense, useEffect, useState } from 'react';
import type { StatusResponse } from '@fretforge/shared';
import { api } from './api';
import { AppProvider, go, parseRoute, useRoute } from './lib/app';
import { TopBar } from './components/TopBar';
import { LibraryView } from './components/LibraryView';
import { SearchView } from './components/SearchView';
import { SettingsView } from './components/SettingsView';
import { SongView } from './player/SongView';
import { AuthScreen, InviteScreen } from './components/AuthScreen';
import { SharedSongView } from './player/SharedSongView';

const RigView = lazy(() => import('./rig/RigView').then((m) => ({ default: m.RigView })));
const NewTabView = lazy(() => import('./editor/NewTabView').then((m) => ({ default: m.NewTabView })));
const JobsView = lazy(() => import('./components/JobsView').then((m) => ({ default: m.JobsView })));

export function App() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const route = useRoute();

  const refresh = () => api.status().then(setStatus).catch((e) => setError(e.message));
  useEffect(() => { refresh(); }, []);

  // share links and invites work without an account
  if (route.name === 'share') return <AppProvider mode="server" version="" user={null}><SharedSongView token={route.token} /></AppProvider>;
  if (error) return <div className="authwrap"><div className="card authcard"><h2>Fretforge can’t start</h2><p className="error">{error}</p><button className="btn" onClick={() => location.reload()}>Try again</button></div></div>;
  if (!status) return <div className="authwrap"><span className="spinner" aria-label="Loading" /></div>;
  if (route.name === 'invite' && !status.authenticated) return <InviteScreen token={route.token} onDone={() => { go('/'); refresh(); }} />;
  if (status.mode === 'server' && (status.needsSetup || !status.authenticated)) {
    const err = parseRoute(location.hash);
    return <AuthScreen setup={status.needsSetup} oidc={status.oidc} error={err.name === 'signin' ? err.error : undefined} onDone={() => { go('/'); refresh(); }} />;
  }

  return (
    <AppProvider mode={status.mode} version={status.version} user={status.user}>
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
        <Suspense fallback={<div className="page"><div className="empty"><span className="spinner" /></div></div>}>
          {route.name === 'library' && <LibraryView playlist={route.playlist} view={route.view} />}
          {route.name === 'search' && <SearchView q={route.q} />}
          {route.name === 'settings' && <SettingsView />}
          {route.name === 'rig' && <RigView />}
          {route.name === 'jobs' && <JobsView />}
          {route.name === 'new' && <NewTabView />}
          {(route.name === 'invite' || route.name === 'signin') && <LibraryView />}
          {route.name === 'song' && <SongView key={route.id} id={route.id} edit={route.edit} onClose={() => (history.length > 1 ? history.back() : go('/'))} />}
        </Suspense>
      </main>
    </div>
  );
}
