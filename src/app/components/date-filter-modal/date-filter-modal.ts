import { Component, input, output } from '@angular/core';

@Component({
  selector: 'app-date-filter-modal',
  templateUrl: './date-filter-modal.html',
})
export class DateFilterModalComponent {
  protected readonly durationSliderMax = 900;
  readonly dateRangeStart = input('');
  readonly dateRangeEnd = input('');
  readonly selectedDay = input('');
  readonly durationMinSeconds = input('');
  readonly durationMaxSeconds = input('');
  readonly matchingVideos = input(0);
  readonly hasDateFilter = input(false);
  readonly close = output<void>();
  readonly dateRangeStartChange = output<Event>();
  readonly dateRangeEndChange = output<Event>();
  readonly selectedDayChange = output<Event>();
  readonly durationMinChange = output<Event>();
  readonly durationMaxChange = output<Event>();
  readonly clear = output<void>();

  protected formatDuration(seconds: number): string {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
  }

  protected durationValue(value: string): number {
    return Number(value || 0);
  }
}
