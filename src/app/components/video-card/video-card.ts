import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  input,
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
export class VideoCardComponent {
  readonly video = input.required<VideoRecord>();
  readonly loaded = input(false);
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

  protected aspectRatio(): string {
    const { width, height } = this.video();
    if (!width || !height || width <= 0 || height <= 0) return '1 / 1';
    return `${width} / ${height}`;
  }

  @ViewChild('mediaFrame', { read: ElementRef })
  readonly mediaFrame?: ElementRef<HTMLElement>;

  protected emitPreviewStart(): void {
    const frame = this.mediaFrame?.nativeElement;
    if (frame) this.previewStart.emit({ video: this.video(), frame });
  }

  protected emitPreviewStop(): void {
    const frame = this.mediaFrame?.nativeElement;
    if (frame) this.previewStop.emit(frame);
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
