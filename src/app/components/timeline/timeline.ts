import {
  AfterViewInit,
  Component,
  DestroyRef,
  ElementRef,
  OnDestroy,
  QueryList,
  Renderer2,
  inject,
  input,
  output,
  signal,
  ViewChildren,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TimelineYearAnchor, TimelineYearGroup } from '../../models/timeline';
import { VideoRecord } from '../../models/video-record';
import { VideoCardComponent, VideoCardPreviewEvent } from '../video-card/video-card';

@Component({
  selector: 'app-timeline',
  imports: [VideoCardComponent],
  host: { '(window:scroll)': 'handleWindowScroll()' },
  templateUrl: './timeline.html',
})
export class TimelineComponent implements AfterViewInit, OnDestroy {
  readonly yearGroups = input.required<TimelineYearGroup[]>();
  readonly yearAnchors = input.required<TimelineYearAnchor[]>();
  readonly catalogLoading = input(false);
  readonly hasDateFilter = input(false);
  readonly dateFilterSummary = input('');
  readonly gridGap = input(6);
  readonly activeMonth = input('');
  readonly loadedVideoIds = input.required<Set<string>>();
  readonly videoDurations = input.required<Map<string, number>>();
  readonly previewLoadingId = input<string | null>(null);
  readonly openVideo = output<VideoRecord>();
  readonly addToExistingAlbum = output<VideoRecord>();
  readonly createAlbum = output<VideoRecord>();
  readonly previewStart = output<VideoCardPreviewEvent>();
  readonly previewStop = output<HTMLElement>();
  readonly durationLoaded = output<{ video: VideoRecord; event: Event }>();
  readonly loadedVideoIdsChange = output<Set<string>>();
  readonly activeMonthChange = output<string>();

  @ViewChildren('daySection', { read: ElementRef })
  private readonly daySections?: QueryList<ElementRef<HTMLElement>>;
  @ViewChildren(VideoCardComponent)
  private readonly videoCards?: QueryList<VideoCardComponent>;
  @ViewChildren('videoGrid', { read: ElementRef })
  private readonly videoGrids?: QueryList<ElementRef<HTMLElement>>;
  protected readonly dateRailHasMore = signal(true);
  protected readonly renderedSectionKeys = signal<Set<string>>(new Set());
  protected readonly sectionHeights = signal<Map<string, number>>(new Map());
  private videoObserver?: IntersectionObserver;
  private dateObserver?: IntersectionObserver;
  private sectionObserver?: IntersectionObserver;
  private gridResizeObserver?: ResizeObserver;
  private virtualScrollFrame?: number;
  private openCard?: VideoCardComponent;
  private readonly destroyRef = inject(DestroyRef);
  private readonly renderer = inject(Renderer2);

  constructor() {
    const removeClickListener = this.renderer.listen('document', 'click', (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element) || !target.closest('.album-add-control')) {
        this.openCard?.closeAlbumMenu();
      }
    });
    const removeKeyListener = this.renderer.listen(
      'document',
      'keydown',
      (event: KeyboardEvent) => {
        if (event.key === 'Escape') this.openCard?.closeAlbumMenu();
      },
    );
    this.destroyRef.onDestroy(() => {
      removeClickListener();
      removeKeyListener();
    });
  }

  ngAfterViewInit(): void {
    this.videoCards?.changes
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.observeMediaFrames());
    this.daySections?.changes.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      this.observeDaySections();
      this.observeVirtualSections();
    });
    this.videoGrids?.changes
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.observeGridSizes());
    this.observeMediaFrames();
    this.observeDaySections();
    this.observeVirtualSections();
    this.observeGridSizes();
  }

  protected setOpenCard(card: VideoCardComponent | null): void {
    if (this.openCard && this.openCard !== card) this.openCard.closeAlbumMenu();
    this.openCard = card ?? undefined;
  }

  ngOnDestroy(): void {
    this.releaseAllLoadedVideos();
    this.videoObserver?.disconnect();
    this.dateObserver?.disconnect();
    this.sectionObserver?.disconnect();
    this.gridResizeObserver?.disconnect();
    if (this.virtualScrollFrame !== undefined) cancelAnimationFrame(this.virtualScrollFrame);
  }

  protected formatDuration(video: VideoRecord): string {
    const duration = this.videoDurations().get(video.id);
    if (duration === undefined) return '';
    const totalSeconds = Math.round(duration);
    const seconds = totalSeconds % 60;
    const minutes = Math.floor(totalSeconds / 60) % 60;
    const hours = Math.floor(totalSeconds / 3600);
    return hours
      ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
      : `${minutes}:${String(seconds).padStart(2, '0')}`;
  }

  protected jumpTo(key: string): void {
    this.activeMonthChange.emit(key);
    this.releaseAllLoadedVideos();
    const group = this.yearGroups()
      .flatMap((year) => year.groups)
      .find((item) => item.monthKey === key);
    document
      .getElementById(group?.key ?? key)
      ?.scrollIntoView({ behavior: 'auto', block: 'start' });
  }

  protected updateDateRailArrow(element: HTMLElement): void {
    this.dateRailHasMore.set(element.scrollTop + element.clientHeight < element.scrollHeight - 1);
  }

  protected sectionHeight(key: string, videoCount: number): number {
    return this.sectionHeights().get(key) ?? this.estimatedGridHeight(videoCount);
  }

  protected handleWindowScroll(): void {
    if (this.virtualScrollFrame !== undefined) return;
    this.virtualScrollFrame = requestAnimationFrame(() => {
      this.virtualScrollFrame = undefined;
      this.updateRenderedSections(document.querySelectorAll<HTMLElement>('[data-virtual-section]'));
    });
  }

  private observeDaySections(): void {
    if (!this.daySections || !('IntersectionObserver' in window)) return;
    this.dateObserver?.disconnect();
    this.dateObserver = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        const monthKey = visible?.target.getAttribute('data-month-key');
        if (monthKey) this.activeMonthChange.emit(monthKey);
      },
      { rootMargin: '-18% 0px -70%', threshold: 0 },
    );
    for (const section of this.daySections) this.dateObserver.observe(section.nativeElement);
  }

  private observeVirtualSections(): void {
    const sections = document.querySelectorAll<HTMLElement>('[data-virtual-section]');
    if (!sections.length || !('IntersectionObserver' in window)) {
      this.renderedSectionKeys.set(new Set([...sections].map((section) => section.id)));
      return;
    }
    this.sectionObserver?.disconnect();
    const initialKeys = [...sections]
      .filter((section) => section.getBoundingClientRect().top < window.innerHeight + 1200)
      .map((section) => section.id);
    this.renderedSectionKeys.set(new Set(initialKeys));
    this.sectionObserver = new IntersectionObserver(
      (entries) => {
        const nextKeys = new Set(this.renderedSectionKeys());
        for (const entry of entries) {
          const key = entry.target.id;
          if (entry.isIntersecting) nextKeys.add(key);
          else nextKeys.delete(key);
        }
        this.renderedSectionKeys.set(nextKeys);
      },
      { rootMargin: '1200px 0px', threshold: 0 },
    );
    for (const section of sections) this.sectionObserver.observe(section);
  }

  private updateRenderedSections(sections: NodeListOf<HTMLElement>): void {
    const nextKeys = new Set<string>();
    for (const section of sections) {
      const bounds = section.getBoundingClientRect();
      if (bounds.bottom >= -1200 && bounds.top <= window.innerHeight + 1200) {
        nextKeys.add(section.id);
      }
    }
    this.renderedSectionKeys.set(nextKeys);
  }

  private observeGridSizes(): void {
    if (!this.videoGrids || !('ResizeObserver' in window)) return;
    this.gridResizeObserver?.disconnect();
    this.gridResizeObserver = new ResizeObserver((entries) => {
      this.sectionHeights.update((heights) => {
        const next = new Map(heights);
        for (const entry of entries) {
          const key =
            entry.target.parentElement?.closest<HTMLElement>('[data-virtual-section]')?.id;
          if (key) next.set(key, Math.ceil(entry.contentRect.height));
        }
        return next;
      });
    });
    for (const grid of this.videoGrids) this.gridResizeObserver.observe(grid.nativeElement);
  }

  private estimatedGridHeight(videoCount: number): number {
    const columns = window.innerWidth <= 900 ? 2 : 4;
    const cardSize = window.innerWidth <= 600 ? 170 : 245;
    return (
      Math.ceil(videoCount / columns) * cardSize +
      Math.max(0, Math.ceil(videoCount / columns) - 1) * 6
    );
  }

  private observeMediaFrames(): void {
    if (!this.videoCards) return;
    if (!('IntersectionObserver' in window)) {
      this.loadedVideoIdsChange.emit(
        new Set(
          this.yearGroups()
            .flatMap((year) => year.groups.flatMap((group) => group.videos))
            .map((video) => video.id),
        ),
      );
      return;
    }
    this.videoObserver?.disconnect();
    this.videoObserver = new IntersectionObserver(
      (entries) => {
        const nextIds = new Set(this.loadedVideoIds());
        for (const entry of entries) {
          const videoId = entry.target.getAttribute('data-video-id');
          if (!videoId) continue;
          if (entry.isIntersecting) nextIds.add(videoId);
          else {
            const video = entry.target.querySelector('video');
            if (video) this.stopVideo(video);
            nextIds.delete(videoId);
          }
        }
        this.loadedVideoIdsChange.emit(nextIds);
      },
      { rootMargin: '300px 0px', threshold: 0 },
    );
    for (const card of this.videoCards) {
      if (card.mediaFrame) this.videoObserver.observe(card.mediaFrame.nativeElement);
    }
  }

  private releaseAllLoadedVideos(): void {
    document
      .querySelectorAll<HTMLVideoElement>('.media-frame video')
      .forEach((video) => this.stopVideo(video));
    this.loadedVideoIdsChange.emit(new Set());
  }

  private stopVideo(video: HTMLVideoElement): void {
    video.pause();
    video.removeAttribute('src');
    video.load();
  }
}
