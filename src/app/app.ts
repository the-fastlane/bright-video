import { CommonModule } from '@angular/common';
import {
  Component,
  DestroyRef,
  HostListener,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { VideoRecord } from './models/video-record';
import { Album, AlbumDraft } from './models/album';
import { TimelineYearAnchor, TimelineYearGroup, VideoGroup } from './models/timeline';
import { DateFilterModalComponent } from './components/date-filter-modal/date-filter-modal';
import { HeaderComponent } from './components/header/header';
import { SettingsModalComponent } from './components/settings-modal/settings-modal';
import { TimelineComponent } from './components/timeline/timeline';
import { VideoCardPreviewEvent } from './components/video-card/video-card';
import { VideoViewerComponent } from './components/video-viewer/video-viewer';

type RescanProgress = {
  mode?: 'scan' | 'reindex' | 'search-reindex' | null;
  processed: number;
  total: number;
  errors: number;
  currentFile: string | null;
  currentPhase: string | null;
  errorDetails: { file: string; phase: string; error: string }[];
  estimatedRemainingMs: number | null;
  stopped?: boolean;
};

@Component({
  selector: 'app-root',
  imports: [
    CommonModule,
    RouterOutlet,
    DateFilterModalComponent,
    HeaderComponent,
    SettingsModalComponent,
    TimelineComponent,
    VideoViewerComponent,
  ],
  templateUrl: './app.html',
})
export class App implements OnInit {
  private readonly groupingStorageKey = 'bright-video-grouping';
  private readonly gridGapStorageKey = 'bright-video-grid-gap';
  private readonly nightModeStorageKey = 'bright-video-night-mode';
  protected readonly videos = signal<VideoRecord[]>([]);
  protected readonly searchQuery = signal('');
  protected readonly searchLoading = signal(false);
  protected readonly albums = signal<Album[]>([]);
  protected readonly albumAssignmentVideo = signal<VideoRecord | null>(null);
  protected readonly albumAssignmentMode = signal<'existing' | 'new'>('existing');
  protected readonly albumAssignmentIds = signal<Set<number>>(new Set());
  protected readonly newAlbumName = signal('');
  protected readonly albumNameError = signal('');
  protected readonly selectedAlbumId = signal<number | null>(null);
  protected readonly catalogLoading = signal(true);
  protected readonly activeVideo = signal<VideoRecord | null>(null);
  protected readonly dateFiltersOpen = signal(false);
  protected readonly settingsOpen = signal(false);
  protected readonly albumsPageRoute = signal(false);
  protected readonly albumSaving = signal(false);
  protected readonly albumStatus = signal('');
  protected readonly nightMode = signal(false);
  protected readonly groupingMode = signal<'day' | 'week' | 'month'>('month');
  protected readonly gridGap = signal(6);
  protected readonly dateRangeStart = signal('');
  protected readonly dateRangeEnd = signal('');
  protected readonly selectedDay = signal('');
  protected readonly durationMinSeconds = signal('');
  protected readonly durationMaxSeconds = signal('');
  protected readonly playingPreview = signal<string | null>(null);
  protected readonly previewLoading = signal<string | null>(null);
  protected readonly videoDurations = signal<Map<string, number>>(new Map());
  protected readonly rescanning = signal(false);
  protected readonly rescanMessage = signal('');
  protected readonly rescanState = signal<'idle' | 'running' | 'success' | 'error'>('idle');
  protected readonly rescanProgress = signal<RescanProgress>({
    processed: 0,
    total: 0,
    errors: 0,
    estimatedRemainingMs: null,
    currentFile: null,
    currentPhase: null,
    errorDetails: [],
  });
  protected readonly activeMonth = signal('2019-11');
  protected readonly loadedVideoIds = signal<Set<string>>(new Set());
  protected readonly mediaDebug = signal(false);
  protected readonly previewTransitionMs = signal(850);
  private suspendedLoadedVideoIds?: Set<string>;
  private previewTimer?: ReturnType<typeof setTimeout>;
  private searchTimer?: ReturnType<typeof setTimeout>;
  private catalogRequestId = 0;
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  ngOnInit(): void {
    void this.loadRuntimeConfig();
    this.loadGroupingPreference();
    this.loadGridGapPreference();
    this.loadNightModePreference();
    this.router.events
      .pipe(
        filter((event) => event instanceof NavigationEnd),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((event) => {
        const url = event.urlAfterRedirects;
        this.albumsPageRoute.set(url.split('?')[0] === '/albums');
        if (!this.albumsPageRoute()) {
          const albumId = Number(new URLSearchParams(url.split('?')[1] ?? '').get('albumId'));
          this.selectedAlbumId.set(Number.isInteger(albumId) && albumId > 0 ? albumId : null);
          void this.loadAlbums();
          this.queueCatalogReload();
        }
      });
    void this.loadCatalog('', true);
    void this.loadAlbums();
    void this.resumeScanStatus();
  }

  private async loadRuntimeConfig(): Promise<void> {
    try {
      const response = await fetch('/api/config');
      if (!response.ok) return;
      const config = (await response.json()) as {
        mediaDebug?: boolean;
        previewTransitionMs?: number;
      };
      this.mediaDebug.set(config.mediaDebug === true);
      if (Number.isFinite(config.previewTransitionMs)) {
        this.previewTransitionMs.set(config.previewTransitionMs!);
      }
    } catch {
      this.mediaDebug.set(false);
    }
  }

  protected toggleNightMode(): void {
    this.nightMode.update((enabled) => {
      const next = !enabled;
      localStorage.setItem(this.nightModeStorageKey, String(next));
      return next;
    });
  }

  protected scanLibrary(): void {
    void this.runScan('/api/scan', 'Starting scan…');
  }

  protected stopScan(): void {
    if (!this.rescanning()) return;
    void fetch('/api/scan-stop', { method: 'POST' });
  }

  protected reindexLibrary(): void {
    void this.runScan('/api/reindex', 'Starting full reindex…');
  }

  protected reindexSearch(): void {
    void this.runScan('/api/reindex-search', 'Starting search reindex…');
  }

  private async runScan(endpoint: string, startMessage: string): Promise<void> {
    if (this.rescanning()) return;
    this.rescanning.set(true);
    this.rescanState.set('running');
    this.rescanProgress.set({
      processed: 0,
      total: 0,
      errors: 0,
      estimatedRemainingMs: null,
      currentFile: null,
      currentPhase: null,
      errorDetails: [],
    });
    this.rescanMessage.set(startMessage);
    try {
      const response = await fetch(endpoint, { method: 'POST' });
      if (!response.ok) throw new Error('Scan unavailable');
      await this.waitForScan();
      await this.loadCatalog(this.searchQuery());
      this.rescanState.set('success');
      const { processed, total, errors, stopped } = this.rescanProgress();
      this.rescanMessage.set(
        stopped
          ? `Stopped after ${processed} of ${total} processed`
          : errors
            ? `${processed} processed, ${errors} skipped`
            : `${processed} videos indexed`,
      );
    } catch {
      this.rescanState.set('error');
      this.rescanMessage.set('Scan failed. Check the local API.');
    } finally {
      this.rescanning.set(false);
    }
  }

  private async waitForScan(): Promise<void> {
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const response = await fetch('/api/scan-status');
      if (!response.ok) throw new Error('Scan status unavailable');
      const status = (await response.json()) as RescanProgress & { active: boolean };
      this.applyScanStatus(status);
      if (!status.active) return;
    }
  }

  private async resumeScanStatus(): Promise<void> {
    try {
      const response = await fetch('/api/scan-status');
      if (!response.ok) return;
      const status = (await response.json()) as RescanProgress & { active: boolean };
      if (!status.active || this.rescanning()) return;
      this.rescanning.set(true);
      this.rescanState.set('running');
      this.applyScanStatus(status);
      await this.waitForScan();
      await this.loadCatalog(this.searchQuery());
      this.rescanState.set('success');
      const { processed, total, errors, stopped } = this.rescanProgress();
      this.rescanMessage.set(
        stopped
          ? `Stopped after ${processed} of ${total} processed`
          : errors
            ? `${processed} processed, ${errors} skipped`
            : `${processed} videos indexed`,
      );
    } catch {
      this.rescanState.set('error');
      this.rescanMessage.set('Scan status unavailable. Check the local API.');
    } finally {
      this.rescanning.set(false);
    }
  }

  private applyScanStatus(status: RescanProgress & { active: boolean }): void {
    this.rescanProgress.set({
      processed: status.processed,
      total: status.total,
      errors: status.errors,
      currentFile: status.currentFile,
      currentPhase: status.currentPhase,
      errorDetails: status.errorDetails,
      estimatedRemainingMs: status.estimatedRemainingMs,
      stopped: status.stopped,
    });
    const remaining = this.formatRemainingTime(status.estimatedRemainingMs);
    const operation =
      status.mode === 'reindex'
        ? 'Reindexing all'
        : status.mode === 'search-reindex'
          ? 'Reindexing search'
          : 'Scanning';
    this.rescanMessage.set(
      status.total
        ? `${operation} ${status.processed} of ${status.total}${remaining ? ` · ${remaining}` : ''}${status.errors ? ` · ${status.errors} skipped` : ''}${status.currentFile ? ` · ${status.currentFile} (${status.currentPhase})` : ''}`
        : 'Scanning library metadata…',
    );
  }

  private formatRemainingTime(milliseconds: number | null): string {
    if (milliseconds === null) return '';
    const totalSeconds = Math.max(1, Math.ceil(milliseconds / 1000));
    if (totalSeconds < 60) return `about ${totalSeconds}s remaining`;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return seconds ? `about ${minutes}m ${seconds}s remaining` : `about ${minutes}m remaining`;
  }

  protected setSearchQuery(event: Event): void {
    const query = (event.target as HTMLInputElement).value;
    this.searchQuery.set(query);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => void this.loadCatalog(query), 250);
  }

  protected setDurationMin(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    const maximum = Number(this.durationMaxSeconds());
    this.durationMinSeconds.set(
      maximum && value > maximum ? String(maximum) : value ? String(value) : '',
    );
    this.queueCatalogReload();
  }

  protected setDurationMax(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    const minimum = Number(this.durationMinSeconds());
    this.durationMaxSeconds.set(value >= 900 ? '' : String(Math.max(value, minimum)));
    this.queueCatalogReload();
  }

  protected setSelectedAlbum(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.selectedAlbumId.set(value ? Number(value) : null);
    this.queueCatalogReload();
  }

  protected setSelectedAlbumById(id: number): void {
    this.selectedAlbumId.set(id);
    this.queueCatalogReload();
  }

  protected async createAlbum(draft: AlbumDraft): Promise<void> {
    const response = await fetch('/api/albums', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(draft),
    });
    if (response.ok) await this.loadAlbums();
  }

  protected openAlbumAssignment(video: VideoRecord, mode: 'existing' | 'new'): void {
    this.albumAssignmentVideo.set(video);
    this.albumAssignmentMode.set(mode);
    this.newAlbumName.set('');
    this.albumNameError.set('');
    this.albumStatus.set('Loading albums...');
    void this.loadAlbumAssignment(video);
  }

  protected closeAlbumAssignment(): void {
    this.albumAssignmentVideo.set(null);
    this.albumAssignmentIds.set(new Set());
    this.albumStatus.set('');
  }

  protected toggleAlbumAssignment(id: number): void {
    this.albumAssignmentIds.update((albumIds) => {
      const next = new Set(albumIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  protected setNewAlbumName(event: Event): void {
    const name = (event.target as HTMLInputElement).value;
    this.newAlbumName.set(name);
    const normalized = name.trim().toLocaleLowerCase();
    this.albumNameError.set(
      !normalized
        ? 'Enter an album name.'
        : this.albums().some((album) => album.name.trim().toLocaleLowerCase() === normalized)
          ? 'An album with this name already exists.'
          : '',
    );
  }

  protected canCreateAlbum(): boolean {
    return Boolean(this.newAlbumName().trim()) && !this.albumNameError();
  }

  protected async saveAlbumAssignment(): Promise<void> {
    const video = this.albumAssignmentVideo();
    if (!video || this.albumSaving()) return;
    await this.saveVideoAlbums(video, this.albumAssignmentIds());
    if (this.albumStatus() === 'Saved') this.closeAlbumAssignment();
  }

  protected async createAndAssignAlbum(): Promise<void> {
    if (!this.canCreateAlbum() || this.albumSaving()) return;
    this.albumSaving.set(true);
    this.albumStatus.set('');
    try {
      const response = await fetch('/api/albums', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: this.newAlbumName(), description: '', displayOrder: 0 }),
      });
      if (!response.ok) {
        this.albumNameError.set(
          response.status === 409
            ? 'An album with this name already exists.'
            : 'Unable to create album.',
        );
        return;
      }
      const body = (await response.json()) as { album?: Album };
      if (!body.album) return;
      await this.loadAlbums();
      this.albumAssignmentIds.set(new Set([body.album.id]));
      const video = this.albumAssignmentVideo();
      if (video) await this.saveVideoAlbums(video, this.albumAssignmentIds());
      if (this.albumStatus() === 'Saved') this.closeAlbumAssignment();
    } catch {
      this.albumStatus.set('Start the local API to create albums');
    } finally {
      this.albumSaving.set(false);
    }
  }

  protected async updateAlbum(event: { id: number; draft: AlbumDraft }): Promise<void> {
    const response = await fetch(`/api/albums/${event.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event.draft),
    });
    if (response.ok) await this.loadAlbums();
  }

  protected async deleteAlbum(id: number): Promise<void> {
    const response = await fetch(`/api/albums/${id}`, { method: 'DELETE' });
    if (response.ok) {
      if (this.selectedAlbumId() === id) this.selectedAlbumId.set(null);
      await this.loadAlbums();
      this.queueCatalogReload();
    }
  }

  private async saveVideoAlbums(video: VideoRecord, albumIds: Set<number>): Promise<void> {
    try {
      const response = await fetch(`/api/videos/${encodeURIComponent(video.path)}/albums`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ albumIds: [...albumIds] }),
      });
      this.albumStatus.set(response.ok ? 'Saved' : 'Unable to save albums');
      if (response.ok && this.selectedAlbumId() !== null) this.queueCatalogReload();
    } catch {
      this.albumStatus.set('Start the local API to save albums');
    } finally {
      this.albumSaving.set(false);
    }
  }

  protected readonly hasDateFilter = computed(() =>
    Boolean(
      this.dateRangeStart() ||
      this.dateRangeEnd() ||
      this.selectedDay() ||
      this.durationMinSeconds() ||
      this.durationMaxSeconds(),
    ),
  );

  protected readonly dateFilterSummary = computed(() => {
    const start = this.dateRangeStart();
    const end = this.dateRangeEnd();
    const day = this.selectedDay();
    return day
      ? `${this.formatFilterDay(day)} across all years`
      : start && end
        ? `${this.formatFilterDate(start)} - ${this.formatFilterDate(end)}`
        : start
          ? `From ${this.formatFilterDate(start)} onward`
          : end
            ? `Through ${this.formatFilterDate(end)}`
            : '';
  });

  // Duration filtering is already applied by the API, so this deliberately does not depend on
  // videoDurations(): letting metadata loads invalidate it would regroup the catalog while scrolling.
  protected readonly filteredVideos = computed(() => {
    const start = this.dateRangeStart();
    const end = this.dateRangeEnd();
    const day = this.selectedDay();
    const minimumMs = Number(this.durationMinSeconds()) * 1000;
    const maximumMs = Number(this.durationMaxSeconds()) * 1000;
    const hasMinimum = Boolean(this.durationMinSeconds());
    const hasMaximum = Boolean(this.durationMaxSeconds());
    return this.videos().filter((video) => {
      const date = this.videoDateKey(video.captureDate);
      if (!date) return false;
      if (day && date.slice(5) !== day) return false;
      if (start && date < start) return false;
      if (end && date > end) return false;
      if (!hasMinimum && !hasMaximum) return true;
      const durationMs = video.durationMs;
      if (durationMs === null || durationMs === undefined) return false;
      if (hasMinimum && durationMs < minimumMs) return false;
      if (hasMaximum && durationMs > maximumMs) return false;
      return true;
    });
  });

  protected setDateRangeStart(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.dateRangeStart.set(value);
    if (value && this.dateRangeEnd() && this.dateRangeEnd() < value) {
      this.dateRangeEnd.set('');
    }
    this.selectedDay.set('');
  }

  protected setDateRangeEnd(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.dateRangeEnd.set(value);
    if (value && this.dateRangeStart() && value < this.dateRangeStart()) {
      this.dateRangeStart.set('');
    }
    this.selectedDay.set('');
  }

  protected setSelectedDay(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.selectedDay.set(value ? value.slice(5) : '');
    this.dateRangeStart.set('');
    this.dateRangeEnd.set('');
  }

  protected clearDateFilters(): void {
    this.dateRangeStart.set('');
    this.dateRangeEnd.set('');
    this.selectedDay.set('');
    this.durationMinSeconds.set('');
    this.durationMaxSeconds.set('');
    this.queueCatalogReload();
  }

  private videoDateKey(value: string | null | undefined): string | null {
    const date = value?.slice(0, 10) ?? '';
    return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
  }

  private formatFilterDate(date: string): string {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(`${date}T00:00:00Z`));
  }

  private formatFilterDay(day: string): string {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(`2000-${day}T00:00:00Z`));
  }

  protected openDateFilters(): void {
    this.dateFiltersOpen.set(true);
  }

  protected closeDateFilters(): void {
    this.dateFiltersOpen.set(false);
  }

  protected openSettings(): void {
    this.settingsOpen.set(true);
  }

  protected openAlbums(): void {
    void this.router.navigate(['/albums']);
  }

  protected closeSettings(): void {
    this.settingsOpen.set(false);
  }

  protected setGroupingMode(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    if (value !== 'day' && value !== 'week' && value !== 'month') return;
    this.groupingMode.set(value);
    localStorage.setItem(this.groupingStorageKey, value);
  }

  protected setGridGap(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    if (!Number.isInteger(value) || value < 2 || value > 10) return;
    this.gridGap.set(value);
    localStorage.setItem(this.gridGapStorageKey, String(value));
  }

  protected readonly groupedVideos = computed<VideoGroup[]>(() => {
    const groups = new Map<string, VideoRecord[]>();
    for (const video of this.filteredVideos()) {
      const groupKey = this.groupKey(video);
      const existing = groups.get(groupKey);
      if (existing) existing.push(video);
      else groups.set(groupKey, [video]);
    }
    return [...groups.entries()].map(([key, videos]) => ({
      key,
      monthKey: videos[0].monthKey,
      label: this.formatGroupLabel(videos[0].captureDate, key),
      videos,
    }));
  });

  protected readonly yearGroups = computed<TimelineYearGroup[]>(() => {
    const years = new Map<number, VideoGroup[]>();
    for (const group of this.groupedVideos()) {
      const year = group.videos[0].year;
      const groups = years.get(year) ?? [];
      groups.push(group);
      years.set(year, groups);
    }
    return [...years.entries()].map(([year, groups]) => ({ year, groups }));
  });

  protected readonly monthAnchors = computed(() => {
    const anchors = new Map<string, VideoGroup>();
    for (const group of this.groupedVideos()) {
      if (!anchors.has(group.monthKey)) anchors.set(group.monthKey, group);
    }
    return [...anchors.values()].map((group) => ({
      key: group.key,
      monthKey: group.monthKey,
      year: group.videos[0].year,
      month: group.videos[0].month,
    }));
  });

  protected readonly yearAnchors = computed<TimelineYearAnchor[]>(() => {
    const years = new Map<number, Array<{ key: string; label: string; month: number }>>();
    for (const anchor of this.monthAnchors()) {
      const month = Number(anchor.monthKey.slice(5, 7));
      const months = years.get(anchor.year) ?? [];
      months.push({ key: anchor.monthKey, label: anchor.month.slice(0, 3), month });
      years.set(anchor.year, months);
    }
    return [...years.entries()].map(([year, months]) => ({
      year,
      months: months.sort((a, b) => a.month - b.month),
    }));
  });

  private loadGroupingPreference(): void {
    const saved = localStorage.getItem(this.groupingStorageKey);
    if (saved === 'day' || saved === 'week' || saved === 'month') this.groupingMode.set(saved);
  }

  private loadGridGapPreference(): void {
    const saved = Number(localStorage.getItem(this.gridGapStorageKey));
    if (Number.isInteger(saved) && saved >= 2 && saved <= 10) this.gridGap.set(saved);
  }

  private groupKey(video: VideoRecord): string {
    const date = this.videoDateKey(video.captureDate);
    if (!date) return 'undated';
    if (this.groupingMode() === 'month') return date.slice(0, 7);
    if (this.groupingMode() === 'week') return this.weekStart(date);
    return date;
  }

  private weekStart(date: string): string {
    const current = new Date(`${date}T00:00:00Z`);
    const day = current.getUTCDay();
    current.setUTCDate(current.getUTCDate() - (day === 0 ? 6 : day - 1));
    return current.toISOString().slice(0, 10);
  }

  private formatGroupLabel(date: string | null, key: string): string {
    if (!date) return 'Undated';
    if (this.groupingMode() === 'month') {
      return new Intl.DateTimeFormat('en-US', {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(new Date(`${key}-01T00:00:00Z`));
    }
    if (this.groupingMode() === 'week') {
      const end = new Date(`${key}T00:00:00Z`);
      end.setUTCDate(end.getUTCDate() + 6);
      return `${this.formatShortDate(new Date(`${key}T00:00:00Z`))} - ${this.formatShortDate(end)}`;
    }
    return this.formatDay(date);
  }

  private formatShortDate(date: Date): string {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(date);
  }

  protected startPreview(video: VideoRecord, frame: HTMLElement): void {
    const element = frame.querySelector('video');
    if (!element) return;
    this.clearPreviewTimer();
    this.previewLoading.set(video.id);
    const playPreview = () => {
      element.muted = true;
      const playAtThumbnailFrame = () => {
        if (!element.isConnected || !element.getAttribute('src')) return;
        const hasRetainedPlayback = Boolean(element.currentSrc) && element.currentTime > 0.01;
        if (!hasRetainedPlayback) element.currentTime = 1;
        const play = () => element.play();
        const seek =
          (hasRetainedPlayback || Math.abs(element.currentTime - 1) < 0.01) &&
          element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
            ? Promise.resolve()
            : new Promise<void>((resolve) => {
                element.addEventListener(
                  hasRetainedPlayback ? 'canplay' : 'seeked',
                  () => resolve(),
                  { once: true },
                );
              });
        seek
          .then(play)
          .then(() => {
            if (!element.isConnected || !element.getAttribute('src')) return;
            this.previewLoading.set(null);
            this.playingPreview.set(video.id);
          })
          .catch(() => {
            if (this.previewLoading() === video.id) this.previewLoading.set(null);
          });
      };
      if (element.readyState >= HTMLMediaElement.HAVE_METADATA) playAtThumbnailFrame();
      else element.addEventListener('loadedmetadata', playAtThumbnailFrame, { once: true });
    };
    playPreview();
  }

  protected stopPreview(frame: HTMLElement): void {
    const element = frame.querySelector('video');
    if (element) {
      element.pause();
      element.removeAttribute('src');
      element.load();
    }
    this.clearPreviewState();
  }

  protected handlePreviewStart(event: VideoCardPreviewEvent): void {
    this.startPreview(event.video, event.frame);
  }

  protected isVideoLoaded(video: VideoRecord): boolean {
    return this.loadedVideoIds().has(video.id);
  }

  protected setVideoDuration(video: VideoRecord, event: Event): void {
    // The catalog already carries durations for indexed videos; only fill real gaps so
    // metadata loads during scrolling do not churn signal state.
    if (video.durationMs !== null && video.durationMs !== undefined) return;
    const duration = (event.target as HTMLVideoElement).duration;
    if (!Number.isFinite(duration) || this.videoDurations().has(video.id)) return;
    this.videoDurations.update((durations) => {
      const next = new Map(durations);
      next.set(video.id, duration);
      return next;
    });
  }

  protected formatDuration(video: VideoRecord): string {
    const duration =
      video.durationMs !== null && video.durationMs !== undefined
        ? video.durationMs / 1000
        : this.videoDurations().get(video.id);
    if (duration === undefined) return '';
    const totalSeconds = Math.round(duration);
    const seconds = totalSeconds % 60;
    const minutes = Math.floor(totalSeconds / 60) % 60;
    const hours = Math.floor(totalSeconds / 3600);
    if (hours) {
      return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }

  protected openViewer(video: VideoRecord): void {
    this.suspendedLoadedVideoIds = new Set(this.loadedVideoIds());
    this.loadedVideoIds.set(new Set());
    this.activeVideo.set(video);
  }

  protected closeViewer(): void {
    this.activeVideo.set(null);
    this.clearPreviewState();
    if (this.suspendedLoadedVideoIds) {
      this.loadedVideoIds.set(this.suspendedLoadedVideoIds);
      this.suspendedLoadedVideoIds = undefined;
    }
  }

  protected readonly viewerIndex = computed(() => {
    const activeId = this.activeVideo()?.id;
    return activeId ? this.filteredVideos().findIndex((video) => video.id === activeId) : -1;
  });

  protected navigateViewer(direction: -1 | 1): void {
    const nextVideo = this.filteredVideos()[this.viewerIndex() + direction];
    if (nextVideo) {
      this.activeVideo.set(nextVideo);
    }
  }

  @HostListener('document:keydown', ['$event'])
  protected handleDocumentKeydown(event: KeyboardEvent): void {
    if (this.activeVideo()) {
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        this.navigateViewer(-1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        this.navigateViewer(1);
      } else if (event.key === 'Escape') {
        this.closeViewer();
      }
    } else if (this.albumAssignmentVideo()) {
      if (event.key === 'Escape') this.closeAlbumAssignment();
    } else if (event.key === 'Escape') {
      if (this.settingsOpen()) this.closeSettings();
      else if (this.dateFiltersOpen()) this.closeDateFilters();
    }
  }

  protected formatDate(date: string): string {
    return new Intl.DateTimeFormat('en', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(date));
  }

  private formatDay(date: string | null): string {
    if (!date) return 'Undated';
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(date));
  }

  private clearPreviewTimer(): void {
    if (this.previewTimer) {
      clearTimeout(this.previewTimer);
      this.previewTimer = undefined;
    }
  }

  private loadNightModePreference(): void {
    this.nightMode.set(localStorage.getItem(this.nightModeStorageKey) === 'true');
  }

  private clearPreviewState(): void {
    this.clearPreviewTimer();
    this.previewLoading.set(null);
    this.playingPreview.set(null);
  }

  private async loadCatalog(query = '', initialLoad = false): Promise<void> {
    const requestId = ++this.catalogRequestId;
    if (initialLoad) this.catalogLoading.set(true);
    else this.searchLoading.set(true);
    try {
      const params = new URLSearchParams();
      if (query.trim()) params.set('q', query.trim());
      if (this.durationMinSeconds())
        params.set('minDurationMs', String(Number(this.durationMinSeconds()) * 1000));
      if (this.durationMaxSeconds())
        params.set('maxDurationMs', String(Number(this.durationMaxSeconds()) * 1000));
      if (this.selectedAlbumId() !== null) params.set('albumId', String(this.selectedAlbumId()));
      const queryString = params.toString();
      const url = queryString ? `/api/videos?${queryString}` : '/api/videos';
      const response = await fetch(url);
      if (!response.ok) return;
      const body = (await response.json()) as { videos?: VideoRecord[] };
      if (requestId === this.catalogRequestId && body.videos) this.videos.set(body.videos);
    } catch {
      // The empty state keeps the app usable while the API is unavailable.
    } finally {
      if (initialLoad) this.catalogLoading.set(false);
      else if (requestId === this.catalogRequestId) this.searchLoading.set(false);
    }
  }

  private queueCatalogReload(): void {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => void this.loadCatalog(this.searchQuery()), 250);
  }

  private async loadAlbums(): Promise<void> {
    try {
      const response = await fetch('/api/albums');
      if (!response.ok) return;
      const body = (await response.json()) as { albums?: Album[] };
      if (body.albums) this.albums.set(body.albums);
    } catch {
      // Album controls remain available when the API is offline.
    }
  }

  private async loadAlbumAssignment(video: VideoRecord): Promise<void> {
    try {
      const response = await fetch(`/api/videos/${encodeURIComponent(video.path)}/albums`);
      if (!response.ok || this.albumAssignmentVideo()?.id !== video.id) return;
      const body = (await response.json()) as { albumIds?: number[] };
      this.albumAssignmentIds.set(new Set(body.albumIds ?? []));
      this.albumStatus.set('');
    } catch {
      if (this.albumAssignmentVideo()?.id === video.id)
        this.albumStatus.set('Unable to load albums');
    }
  }
}
