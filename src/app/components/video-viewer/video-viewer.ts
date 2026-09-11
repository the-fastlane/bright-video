import { Component, input, output } from '@angular/core';
import { VideoRecord } from '../../models/video-record';

@Component({
  selector: 'app-video-viewer',
  templateUrl: './video-viewer.html',
})
export class VideoViewerComponent {
  readonly video = input.required<VideoRecord>();
  readonly dateLabel = input.required<string>();
  readonly canGoPrevious = input(false);
  readonly canGoNext = input(false);
  readonly close = output<void>();
  readonly previous = output<void>();
  readonly next = output<void>();
}
