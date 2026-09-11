import { Component, OnInit, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Album, AlbumDraft } from '../../models/album';

@Component({
  selector: 'app-albums-page',
  templateUrl: './albums-page.html',
})
export class AlbumsPageComponent implements OnInit {
  private readonly router = inject(Router);
  protected readonly albums = signal<Album[]>([]);
  protected readonly selectedAlbumId = signal<number | null>(null);

  ngOnInit(): void {
    void this.loadAlbums();
  }

  protected close(): void {
    void this.router.navigate(['/']);
  }

  protected draftFromForm(form: HTMLFormElement): AlbumDraft {
    const data = new FormData(form);
    return {
      name: String(data.get('name') ?? ''),
      description: String(data.get('description') ?? ''),
      displayOrder: Number(data.get('displayOrder') ?? 0),
    };
  }

  protected createAlbum(event: SubmitEvent): void {
    event.preventDefault();
    void this.createAlbumRequest(this.draftFromForm(event.target as HTMLFormElement));
    (event.target as HTMLFormElement).reset();
  }

  protected updateAlbum(event: SubmitEvent, id: number): void {
    event.preventDefault();
    void this.updateAlbumRequest(id, this.draftFromForm(event.target as HTMLFormElement));
  }

  protected async selectAlbum(id: number): Promise<void> {
    await this.router.navigate(['/'], { queryParams: { albumId: id } });
  }

  protected async loadAlbums(): Promise<void> {
    try {
      const response = await fetch('/api/albums');
      if (!response.ok) return;
      const body = (await response.json()) as { albums?: Album[] };
      this.albums.set(body.albums ?? []);
    } catch {
      // The empty state remains useful while the local API is offline.
    }
  }

  private async createAlbumRequest(draft: AlbumDraft): Promise<void> {
    const response = await fetch('/api/albums', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(draft),
    });
    if (response.ok) await this.loadAlbums();
  }

  private async updateAlbumRequest(id: number, draft: AlbumDraft): Promise<void> {
    const response = await fetch(`/api/albums/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(draft),
    });
    if (response.ok) await this.loadAlbums();
  }

  protected async deleteAlbum(id: number): Promise<void> {
    const response = await fetch(`/api/albums/${id}`, { method: 'DELETE' });
    if (response.ok) {
      if (this.selectedAlbumId() === id) this.selectedAlbumId.set(null);
      await this.loadAlbums();
    }
  }
}