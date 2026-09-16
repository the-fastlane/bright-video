import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  input,
  OnDestroy,
  output,
  signal,
  ViewChild,
} from '@angular/core';
import { VideoRecord } from '../../models/video-record';

export type VideoCardPreviewEvent = {
  video: VideoRecord;
  frame: HTMLElement;
};

@Component({
  selector: 'app-video-card',
  templateUrl: './video-card.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VideoCardComponent implements OnDestroy {
  readonly video = input.required<VideoRecord>();
  readonly loaded = input(false);
  readonly mediaDebug = input(false);
  readonly duration = input('');
  readonly previewLoading = input(false);
  readonly open = output<VideoRecord>();
  readonly addToExistingAlbum = output<VideoRecord>();
  readonly createAlbum = output<VideoRecord>();
  readonly previewStart = output<VideoCardPreviewEvent>();
  readonly previewStop = output<HTMLElement>();
  readonly durationLoaded = output<{ video: VideoRecord; event: Event }>();
  readonly menuOpened = output<VideoCardComponent | null>();
  protected readonly menuOpen = signal(false);
  protected readonly previewActive = signal(false);
  protected readonly previewPlaying = signal(false);
  protected readonly previewFrameVisible = signal(false);
  protected readonly previewStopped = signal(false);
  protected readonly thumbnailUnavailable = signal(false);
  private hoverTimer?: ReturnType<typeof setTimeout>;

  protected aspectRatio(): string {
    const { width, height } = this.video();
    if (!width || !height || width <= 0 || height <= 0) return '1 / 1';
    return `${width} / ${height}`;
  }

  @ViewChild('mediaFrame', { read: ElementRef })
  readonly mediaFrame?: ElementRef<HTMLElement>;

  protected emitPreviewStart(): void {
    this.clearHoverTimer();
    this.hoverTimer = setTimeout(() => {
      this.previewActive.set(true);
      this.previewPlaying.set(false);
      this.previewStopped.set(false);
      const frame = this.mediaFrame?.nativeElement;
      if (frame) this.previewStart.emit({ video: this.video(), frame });
    }, 200);
  }

  private clearHoverTimer(): void {
    if (this.hoverTimer) {
      clearTimeout(this.hoverTimer);
      this.hoverTimer = undefined;
    }
  }

  protected emitPreviewStop(): void {
    this.clearHoverTimer();
    this.previewActive.set(false);
    this.previewStopped.set(true);
    const frame = this.mediaFrame?.nativeElement;
    if (frame) {
      if (!this.previewFrameVisible()) {
        const video = frame.querySelector('video');
        if (video && video.getAttribute('src')) {
          video.pause();
          video.removeAttribute('src');
          video.load();
        }
      }
      this.previewStop.emit(frame);
    }
  }

  ngOnDestroy(): void {
    this.clearHoverTimer();
  }

  protected handleThumbnailError(): void {
    this.thumbnailUnavailable.set(true);
  }

  protected logMediaEvent(event: Event): void {
    if (!this.mediaDebug()) return;
    const video = event.currentTarget as HTMLVideoElement;
    console.log('[media:browser]', event.type, this.video().filename, {
      readyState: video.readyState,
      networkState: video.networkState,
      currentSrc: video.currentSrc,
      time: Math.round(performance.now()),
    });
  }

  protected handleLoadedMetadata(event: Event): void {
    this.logMediaEvent(event);
    const video = event.currentTarget as HTMLVideoElement;
    if (video.duration > 1) video.currentTime = 1;
    this.durationLoaded.emit({ video: this.video(), event });
  }

  protected handlePlaying(event: Event): void {
    this.logMediaEvent(event);
    this.previewPlaying.set(true);
    this.previewFrameVisible.set(true);
  }

  protected handleEmptied(): void {
    this.previewPlaying.set(false);
    this.previewFrameVisible.set(false);
  }

  protected stopCardClick(event: Event): void {
    event.stopPropagation();
  }

  protected toggleAlbumMenu(event: Event): void {
    this.stopCardClick(event);
    const next = !this.menuOpen();
    this.menuOpen.set(next);
    this.menuOpened.emit(next ? this : null);
  }

  closeAlbumMenu(): void {
    if (!this.menuOpen()) return;
    this.menuOpen.set(false);
    this.menuOpened.emit(null);
  }
}
