import {
  Component,
  ElementRef,
  input,
  OnChanges,
  OnDestroy,
  output,
  signal,
  SimpleChanges,
  ViewChild,
} from '@angular/core';
import { VideoRecord } from '../../models/video-record';

@Component({
  selector: 'app-video-viewer',
  templateUrl: './video-viewer.html',
})
export class VideoViewerComponent implements OnChanges, OnDestroy {
  readonly video = input.required<VideoRecord>();
  readonly dateLabel = input.required<string>();
  readonly canGoPrevious = input(false);
  readonly canGoNext = input(false);
  readonly close = output<void>();
  readonly previous = output<void>();
  readonly next = output<void>();
  protected readonly mediaLoading = signal(true);

  @ViewChild('viewerVideo')
  private readonly viewerVideo?: ElementRef<HTMLVideoElement>;

  protected stopMedia(): void {
    const video = this.viewerVideo?.nativeElement;
    if (!video) return;
    video.pause();
    video.removeAttribute('src');
    video.load();
  }

  protected startAtOneSecond(event: Event): void {
    const video = event.currentTarget as HTMLVideoElement;
    if (video.duration > 1) video.currentTime = 1;
  }

  protected finishMediaLoad(): void {
    this.mediaLoading.set(false);
  }

  protected keywordList(): string[] {
    return (this.video().keywords ?? '')
      .split(',')
      .map((keyword) => keyword.trim())
      .filter(Boolean);
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['video'] && !changes['video'].firstChange) {
      this.mediaLoading.set(true);
    }
  }

  ngOnDestroy(): void {
    this.stopMedia();
  }

  protected closeViewer(): void {
    this.stopMedia();
    this.close.emit();
  }

  protected navigate(direction: 'previous' | 'next'): void {
    this.mediaLoading.set(true);
    this[direction].emit();
  }
}
