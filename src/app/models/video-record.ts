export interface VideoRecord {
  id: string;
  title: string;
  filename: string;
  path: string;
  url: string;
  captureDate: string;
  year: number;
  month: string;
  monthKey: string;
  description: string;
  format: string;
  durationMs?: number | null;
  width?: number | null;
  height?: number | null;
  photosUrl?: string;
}
