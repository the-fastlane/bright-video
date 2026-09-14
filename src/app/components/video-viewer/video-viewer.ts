import { Component, ElementRef, input, OnDestroy, output, ViewChild } from '@angular/core';
import { VideoRecord } from '../../models/video-record';

@Component({
  selector: 'app-video-viewer',
  templateUrl: './video-viewer.html',
})
export class VideoViewerComponent implements OnDestroy {
  readonly video = input.required<VideoRecord>();
  readonly dateLabel = input.required<string>();
  readonly canGoPrevious = input(false);
  readonly canGoNext = input(false);
  readonly close = output<void>();
  readonly previous = output<void>();
  readonly next = output<void>();

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

  ngOnDestroy(): void {
    this.stopMedia();
  }

  protected closeViewer(): void {
    this.stopMedia();
    this.close.emit();
  }

  protected navigate(direction: 'previous' | 'next'): void {
    this.stopMedia();
    this[direction].emit();
  }
}
