import { Component, input, output } from '@angular/core';

@Component({
  selector: 'app-settings-modal',
  templateUrl: './settings-modal.html',
})
export class SettingsModalComponent {
  readonly groupingMode = input.required<'day' | 'week' | 'month'>();
  readonly gridGap = input.required<number>();
  readonly aiSearchEnabled = input(false);
  readonly aiAnalysis = input<{ total?: number; complete?: number; pending?: number }>({});
  readonly close = output<void>();
  readonly groupingChange = output<Event>();
  readonly gridGapChange = output<Event>();
  readonly aiSearchChange = output<Event>();
}
