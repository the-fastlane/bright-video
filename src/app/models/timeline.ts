import { VideoRecord } from './video-record';

export type VideoGroup = {
  key: string;
  monthKey: string;
  label: string;
  videos: VideoRecord[];
};

export type TimelineYearGroup = {
  year: number;
  groups: VideoGroup[];
};

export type TimelineYearAnchor = {
  year: number;
  months: Array<{ key: string; label: string; month: number }>;
};
