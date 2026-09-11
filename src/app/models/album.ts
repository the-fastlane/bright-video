export interface Album {
  id: number;
  name: string;
  description: string;
  display_order: number;
  created_at: string;
  updated_at: string;
}

export interface AlbumDraft {
  name: string;
  description: string;
  displayOrder: number;
}
