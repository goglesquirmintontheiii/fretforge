// A YouTube video as the player's clock: alphaTab follows it in external-media mode, the
// same way it follows the mix engine. Uses the YouTube IFrame Player API.

interface YtPlayer {
  playVideo(): void; pauseVideo(): void; seekTo(s: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number; getDuration(): number; getPlayerState(): number;
  setPlaybackRate(r: number): void; getAvailablePlaybackRates(): number[];
  setVolume(v: number): void; unMute(): void; loadVideoById(o: { videoId: string; startSeconds?: number }): void; cueVideoById(o: { videoId: string; startSeconds?: number }): void;
  destroy(): void;
}
interface YtNamespace { Player: new (el: HTMLElement, opts: unknown) => YtPlayer; PlayerState: Record<string, number> }
declare global { interface Window { YT?: YtNamespace; onYouTubeIframeAPIReady?: () => void } }

let apiPromise: Promise<YtNamespace> | null = null;
function loadApi(): Promise<YtNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  apiPromise ??= new Promise<YtNamespace>((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(window.YT!); };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.async = true;
    s.onerror = () => { apiPromise = null; reject(new Error('YouTube couldn’t be reached. Check your internet connection.')); };
    document.head.appendChild(s);
  });
  return apiPromise;
}

const ERRORS: Record<number, string> = {
  2: 'This video link isn’t valid.',
  5: 'This video can’t play in an embedded player.',
  100: 'This video was removed or is private.',
  101: 'The video’s owner doesn’t allow it to play outside YouTube.',
  150: 'The video’s owner doesn’t allow it to play outside YouTube.',
  153: 'YouTube refused to play the video here.',
};

export class YtClock {
  /** the element YouTube renders into; the video dock adopts it */
  readonly host = document.createElement('div');
  private player: YtPlayer | null = null;
  private videoId: string | null = null;
  private ready: Promise<void> | null = null;
  private mountWait: { promise: Promise<void>; resolve: () => void };
  private posL = new Set<(ms: number) => void>();
  private endL = new Set<() => void>();
  private errL = new Set<(msg: string) => void>();
  private remoteL = new Set<(playing: boolean) => void>();
  private timer = 0;
  private rate = 1;
  private loop: { startMs: number; endMs: number } | null = null;
  private wantPlaying = false;
  /** smooth position between YouTube's coarse time updates */
  private anchor = { ms: 0, at: 0 };
  lastMs = 0;
  durationMs = 0;
  readonly latencyMs = 0;

  constructor() {
    this.host.className = 'yt-host';
    let resolve!: () => void;
    this.mountWait = { promise: new Promise<void>((r) => { resolve = r; }), resolve };
    this.mountWait.resolve = resolve;
  }

  /** called by the dock once the host is in the document */
  mounted() { this.mountWait.resolve(); }

  onPosition(cb: (ms: number) => void) { this.posL.add(cb); return () => { this.posL.delete(cb); }; }
  onEnded(cb: () => void) { this.endL.add(cb); return () => { this.endL.delete(cb); }; }
  onError(cb: (msg: string) => void) { this.errL.add(cb); return () => { this.errL.delete(cb); }; }
  /** play or pause pressed on the video itself */
  onRemote(cb: (playing: boolean) => void) { this.remoteL.add(cb); return () => { this.remoteL.delete(cb); }; }

  /** Loads (or switches to) a video; resolves when it's cued and its duration is known. */
  load(videoId: string): Promise<void> {
    if (this.videoId === videoId && this.ready) return this.ready;
    this.videoId = videoId;
    this.ready = (async () => {
      const YT = await loadApi();
      await this.mountWait.promise;
      if (!this.player) {
        const el = document.createElement('div');
        this.host.replaceChildren(el);
        await new Promise<void>((resolve, reject) => {
          this.player = new YT.Player(el, {
            videoId, width: '100%', height: '100%',
            playerVars: { playsinline: 1, rel: 0, modestbranding: 1, controls: 1, disablekb: 1, fs: 1, origin: location.origin },
            events: {
              onReady: () => resolve(),
              onStateChange: (e: { data: number }) => this.state(e.data),
              onError: (e: { data: number }) => { const m = ERRORS[e.data] ?? `YouTube error ${e.data}.`; this.errL.forEach((f) => f(m)); reject(new Error(m)); },
            },
          });
        });
      } else {
        this.player.cueVideoById({ videoId });
      }
      // the duration is 0 until the video's metadata arrives
      for (let i = 0; i < 60 && !(this.player!.getDuration() > 0); i++) await new Promise((r) => setTimeout(r, 100));
      this.durationMs = (this.player!.getDuration() || 0) * 1000;
      this.player!.setPlaybackRate(this.rate);
    })();
    this.ready.catch(() => { this.ready = null; this.videoId = null; });
    return this.ready;
  }

  whenReady() { return this.ready ?? Promise.resolve(); }

  private state(s: number) {
    // -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued
    if (s === 1) {
      this.anchorNow();
      this.tick();
      if (!this.wantPlaying) { this.wantPlaying = true; this.remoteL.forEach((f) => f(true)); }
    }
    if (s === 0) { this.wantPlaying = false; this.stopTick(); this.endL.forEach((f) => f()); }
    if (s === 2 && this.wantPlaying) {
      // paused from YouTube's own controls: the tab player pauses too
      this.wantPlaying = false;
      this.stopTick();
      this.emit(this.readMs());
      this.remoteL.forEach((f) => f(false));
    }
  }

  private readMs() { return (this.player?.getCurrentTime() ?? 0) * 1000; }
  private anchorNow() { this.anchor = { ms: this.readMs(), at: performance.now() }; }

  private emit(ms: number) { this.lastMs = ms; this.posL.forEach((f) => f(ms)); }

  private tick = () => {
    cancelAnimationFrame(this.timer);
    const loop = () => {
      if (!this.player) return;
      const raw = this.readMs();
      const playing = this.player.getPlayerState() === 1;
      // YouTube's time moves in steps; extrapolate between them while playing
      if (raw !== this.anchor.ms) this.anchor = { ms: raw, at: performance.now() };
      const ms = playing ? this.anchor.ms + (performance.now() - this.anchor.at) * this.rate : raw;
      if (this.loop && ms >= this.loop.endMs) {
        this.player.seekTo(this.loop.startMs / 1000, true);
        this.anchor = { ms: this.loop.startMs, at: performance.now() };
        this.emit(this.loop.startMs);
      } else this.emit(ms);
      this.timer = requestAnimationFrame(loop);
    };
    this.timer = requestAnimationFrame(loop);
  };
  private stopTick() { cancelAnimationFrame(this.timer); }

  async play() {
    await this.whenReady();
    this.wantPlaying = true;
    this.player?.unMute();
    this.player?.playVideo();
    this.tick();
  }
  pause() {
    this.wantPlaying = false;
    this.player?.pauseVideo();
    this.stopTick();
    if (this.player) this.emit(this.readMs());
  }
  seek(ms: number) {
    this.lastMs = ms;
    this.anchor = { ms, at: performance.now() };
    this.player?.seekTo(Math.max(0, ms) / 1000, true);
  }
  setRate(rate: number) {
    // YouTube plays 0.25x–2x
    this.rate = Math.min(2, Math.max(0.25, rate));
    this.player?.setPlaybackRate(this.rate);
    this.anchorNow();
  }
  setMaster(gain: number) { this.player?.setVolume(Math.round(Math.min(1, Math.max(0, gain)) * 100)); }
  setLoop(r: { startMs: number; endMs: number } | null) { this.loop = r && r.endMs > r.startMs ? r : null; }

  destroy() {
    this.stopTick();
    try { this.player?.destroy(); } catch { /* already gone */ }
    this.player = null;
    this.ready = null;
    this.videoId = null;
    this.host.remove();
  }
}
