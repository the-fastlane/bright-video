import { Component, input, output } from '@angular/core';

type RescanProgress = {
  processed: number;
  total: number;
  errors: number;
  estimatedRemainingMs: number | null;
  currentFile: string | null;
  currentPhase: string | null;
  errorDetails: { file: string; phase: string; error: string }[];
};

@Component({
  selector: 'app-header',
  templateUrl: './header.html',
})
export class HeaderComponent {
  readonly videoCount = input(0);
  readonly searchQuery = input('');
  readonly searchLoading = input(false);
  readonly hasDateFilter = input(false);
  readonly dateFilterSummary = input('');
  readonly nightMode = input(false);
  readonly rescanning = input(false);
  readonly rescanMessage = input('');
  readonly rescanState = input<'idle' | 'running' | 'success' | 'error'>('idle');
  readonly rescanProgress = input<RescanProgress>({
    processed: 0,
    total: 0,
    errors: 0,
    estimatedRemainingMs: null,
    currentFile: null,
    currentPhase: null,
    errorDetails: [],
  });
  readonly openDateFilters = output<void>();
  readonly toggleNightMode = output<void>();
  readonly openSettings = output<void>();
  readonly openAlbums = output<void>();
  readonly scanLibrary = output<void>();
  readonly stopScan = output<void>();
  readonly reindexLibrary = output<void>();
  readonly searchChange = output<Event>();
}
