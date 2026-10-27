import { api } from '../api';
import { JobRow, useJobs } from '../player/AudioPanel';

export function JobsView() {
  const { jobs, ai, refresh } = useJobs();
  return (
    <div className="page" style={{ maxWidth: 760 }}>
      <div className="section-h">
        <h2>AI jobs</h2>
        <span className="muted">{ai ? (ai.available ? `Worker ready on ${ai.device?.toUpperCase()}` : ai.reason) : ''}</span>
        <span className="grow" />
        <button className="btn sm" onClick={() => api.clearJobs().then(refresh)}>Clear finished</button>
      </div>
      {jobs.length === 0 ? <div className="empty"><b>No jobs</b>Separations, syncs, downloads and trainings show up here.</div> : (
        <div className="card" style={{ padding: 14, display: 'grid', gap: 12 }}>
          {jobs.map((j) => (
            <div key={j.id}>
              <JobRow j={j} onCancel={() => api.cancelJob(j.id).then(refresh)} />
              {j.songId && <a href={`#/song/${j.songId}`} style={{ fontSize: 12 }}>Open the song</a>}
              {j.scheduled && j.state === 'queued' && <span className="faint" style={{ fontSize: 12 }}> · waits for the idle window</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
