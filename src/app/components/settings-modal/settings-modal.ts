import { Component, input, output } from '@angular/core';

export interface AiIndexingStatus {
  enabled: boolean;
  active: boolean;
  total: number;
  processed: number;
  remaining: number;
  errors: number;
  estimatedRemainingMs: number | null;
  currentFile?: string | null;
  completed: boolean;
  runFinished: boolean;
  error?: string | null;
}

@Component({
  selector: 'app-settings-modal',
  templateUrl: './settings-modal.html',
})
export class SettingsModalComponent {
  readonly groupingMode = input.required<'day' | 'week' | 'month'>();
  readonly gridGap = input.required<number>();
  readonly aiStatus = input<AiIndexingStatus | null>(null);
  readonly close = output<void>();
  readonly groupingChange = output<Event>();
  readonly gridGapChange = output<Event>();
  readonly aiToggleChange = output<boolean>();
  readonly aiReset = output<void>();

  protected onAiToggle(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.aiToggleChange.emit(input.checked);
  }

  protected progressPercent(status: AiIndexingStatus): number {
    if (!status.total) return 0;
    return Math.min(100, Math.round((status.processed / status.total) * 100));
  }

  protected formatEta(ms: number | null): string {
    if (!ms || ms <= 0) return '';
    const seconds = Math.ceil(ms / 1000);
    if (seconds < 60) return `~${seconds}s remaining`;
    const minutes = Math.ceil(seconds / 60);
    if (minutes < 60) return `~${minutes}m remaining`;
    const hours = Math.floor(minutes / 60);
    const remainingMins = minutes % 60;
    return `~${hours}h ${remainingMins}m remaining`;
  }
}
