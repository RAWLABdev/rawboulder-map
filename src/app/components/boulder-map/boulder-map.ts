import { isPlatformBrowser } from '@angular/common';
import {
  AfterViewInit,
  Component,
  computed,
  Inject,
  OnDestroy,
  PLATFORM_ID,
  signal,
} from '@angular/core';

import type * as Leaflet from 'leaflet';

import { BOULDER_SPOTS } from '../../data/boulder-spots';
import {
  BoulderSpot,
  BoulderSpotType,
} from '../../models/boulder-spot';

type SpotFilter = 'all' | BoulderSpotType;
type SheetState = 'closed' | 'peek' | 'expanded';

type UserLocation = {
  latitude: number;
  longitude: number;
};

@Component({
  selector: 'app-boulder-map',
  standalone: true,
  templateUrl: './boulder-map.html',
  styleUrl: './boulder-map.css',
})
export class BoulderMapComponent
  implements AfterViewInit, OnDestroy
{
  readonly spots = signal<BoulderSpot[]>(BOULDER_SPOTS);

  readonly query = signal('');
  readonly activeFilter = signal<SpotFilter>('all');

  readonly selectedSpot = signal<BoulderSpot | null>(null);
  readonly sheetState = signal<SheetState>('closed');

  readonly sheetDragOffset = signal(0);
  readonly isDraggingSheet = signal(false);

  readonly locating = signal(false);
  readonly locationStatus = signal('');
  readonly shareStatus = signal('');

  readonly favoriteIds = signal<Set<string>>(new Set());

  readonly filteredSpots = computed(() => {
    const query = this.query().trim().toLowerCase();
    const activeFilter = this.activeFilter();

    return this.spots().filter((spot) => {
      const matchesFilter =
        activeFilter === 'all' ||
        spot.type === activeFilter;

      const searchableContent = [
        spot.name,
        spot.commune,
        spot.address,
        ...spot.tags,
      ]
        .join(' ')
        .toLowerCase();

      const matchesQuery =
        query.length === 0 ||
        searchableContent.includes(query);

      return matchesFilter && matchesQuery;
    });
  });

  readonly resultLabel = computed(() => {
    const total = this.filteredSpots().length;

    return total === 1
      ? '1 lugar'
      : `${total} lugares`;
  });

  private map?: Leaflet.Map;
  private leaflet?: typeof Leaflet;

  private userMarker?: Leaflet.Marker;
  private userLocation?: UserLocation;

  private readonly markers = new Map<
    string,
    Leaflet.Marker
  >();

  private dragStartY = 0;
  private dragLastY = 0;
  private dragPointerId?: number;

  private readonly handlePopState = (): void => {
    this.restoreSpotFromUrl(false);
  };

  constructor(
    @Inject(PLATFORM_ID)
    private readonly platformId: object
  ) {}

  async ngAfterViewInit(): Promise<void> {
    if (!isPlatformBrowser(this.platformId)) {
      return;
    }

    this.loadFavorites();

    const leafletModule = await import('leaflet');

    const leaflet =
      (
        leafletModule as typeof leafletModule & {
          default?: typeof Leaflet;
        }
      ).default ?? leafletModule;

    this.leaflet = leaflet as typeof Leaflet;

    this.initializeMap();
    this.createMarkers();

    window.addEventListener(
      'popstate',
      this.handlePopState
    );

    this.restoreSpotFromUrl(false);

    window.setTimeout(() => {
      this.map?.invalidateSize();

      if (!this.selectedSpot()) {
        this.fitVisibleMarkers();
      }
    }, 0);
  }

  ngOnDestroy(): void {
    if (!isPlatformBrowser(this.platformId)) {
      return;
    }

    window.removeEventListener(
      'popstate',
      this.handlePopState
    );

    this.map?.remove();
    this.map = undefined;

    this.markers.clear();
  }

  onSearch(event: Event): void {
    const input = event.target as HTMLInputElement;

    this.query.set(input.value);
    this.applyResults();
  }

  clearSearch(): void {
    this.query.set('');
    this.applyResults();
  }

  setFilter(filter: SpotFilter): void {
    this.activeFilter.set(filter);
    this.applyResults();
  }

  selectSpot(
    spot: BoulderSpot,
    updateUrl = true
  ): void {
    this.selectedSpot.set(spot);
    this.sheetState.set('peek');
    this.sheetDragOffset.set(0);

    this.updateMarkerStyles();
    this.focusMapOnSpot(spot);

    if (updateUrl) {
      this.updateSpotUrl(spot);
    }

    window.setTimeout(() => {
      this.markers.get(spot.id)?.openPopup();
      this.updateMapPadding();
    }, 420);
  }

  toggleSheet(): void {
    this.sheetState.update((state) =>
      state === 'expanded' ? 'peek' : 'expanded'
    );

    this.sheetDragOffset.set(0);

    window.setTimeout(() => {
      this.map?.invalidateSize();
      this.updateMapPadding();
    }, 320);
  }

  closeSheet(
    event?: Event,
    updateUrl = true
  ): void {
    event?.stopPropagation();

    this.sheetState.set('closed');
    this.sheetDragOffset.set(0);
    this.selectedSpot.set(null);

    this.map?.closePopup();
    this.updateMarkerStyles();

    if (updateUrl) {
      this.clearSpotUrl(true);
    }

    window.setTimeout(() => {
      this.map?.invalidateSize();
    }, 320);
  }

  openFirstVisibleSpot(): void {
    const firstSpot = this.filteredSpots()[0];

    if (firstSpot) {
      this.selectSpot(firstSpot);
    }
  }

  onSheetPointerDown(event: PointerEvent): void {
    if (event.button !== 0) {
      return;
    }

    this.dragPointerId = event.pointerId;
    this.dragStartY = event.clientY;
    this.dragLastY = event.clientY;

    this.isDraggingSheet.set(true);
    this.sheetDragOffset.set(0);

    const target = event.currentTarget as HTMLElement;

    target.setPointerCapture(event.pointerId);
  }

  onSheetPointerMove(event: PointerEvent): void {
    if (
      !this.isDraggingSheet() ||
      event.pointerId !== this.dragPointerId
    ) {
      return;
    }

    this.dragLastY = event.clientY;

    const offset =
      event.clientY - this.dragStartY;

    this.sheetDragOffset.set(offset);
  }

  onSheetPointerUp(event: PointerEvent): void {
    if (
      !this.isDraggingSheet() ||
      event.pointerId !== this.dragPointerId
    ) {
      return;
    }

    const offset =
      this.dragLastY - this.dragStartY;

    this.isDraggingSheet.set(false);
    this.sheetDragOffset.set(0);

    const target = event.currentTarget as HTMLElement;

    if (target.hasPointerCapture(event.pointerId)) {
      target.releasePointerCapture(event.pointerId);
    }

    this.dragPointerId = undefined;

    if (offset < -70) {
      this.sheetState.set('expanded');
    } else if (offset > 120) {
      if (this.sheetState() === 'expanded') {
        this.sheetState.set('peek');
      } else {
        this.closeSheet();
        return;
      }
    }

    window.setTimeout(() => {
      this.updateMapPadding();
    }, 320);
  }

  isFavorite(spotId: string): boolean {
    return this.favoriteIds().has(spotId);
  }

  toggleFavorite(
    spot: BoulderSpot,
    event: Event
  ): void {
    event.stopPropagation();

    const nextFavorites = new Set(
      this.favoriteIds()
    );

    if (nextFavorites.has(spot.id)) {
      nextFavorites.delete(spot.id);
    } else {
      nextFavorites.add(spot.id);
    }

    this.favoriteIds.set(nextFavorites);
    this.persistFavorites(nextFavorites);
  }

  async shareSpot(
    spot: BoulderSpot,
    event: Event
  ): Promise<void> {
    event.stopPropagation();

    const url = this.getShareUrl(spot);
    const title =
      `${spot.name} · RAWBOULDER MAP`;
    const text =
      `Mira ${spot.name} en RAWBOULDER MAP.`;

    try {
      if (navigator.share) {
        await navigator.share({
          title,
          text,
          url,
        });

        this.showShareStatus(
          'Lugar compartido.'
        );

        return;
      }

      await navigator.clipboard.writeText(url);

      this.showShareStatus(
        'Enlace copiado.'
      );
    } catch (error) {
      if (
        error instanceof DOMException &&
        error.name === 'AbortError'
      ) {
        return;
      }

      this.showShareStatus(
        'No pudimos compartir el lugar.'
      );
    }
  }

  /**
   * Genera una ruta hacia el lugar.
   *
   * Si el usuario ya permitió su ubicación:
   * origen = ubicación actual
   * destino = boulder seleccionado
   *
   * Si aún no dio permiso, Google Maps intentará
   * usar automáticamente su ubicación actual.
   */
  getDirectionsUrl(spot: BoulderSpot): string {
    const url = new URL(
      'https://www.google.com/maps/dir/'
    );

    url.searchParams.set('api', '1');

    url.searchParams.set(
      'destination',
      `${spot.lat},${spot.lng}`
    );

    url.searchParams.set(
      'travelmode',
      'walking'
    );

    if (this.userLocation) {
      url.searchParams.set(
        'origin',
        `${this.userLocation.latitude},${this.userLocation.longitude}`
      );
    }

    return url.toString();
  }

  findNearestSpot(): void {
    if (!navigator.geolocation) {
      this.locationStatus.set(
        'Tu navegador no permite utilizar ubicación.'
      );

      return;
    }

    this.locating.set(true);
    this.locationStatus.set(
      'Buscando tu ubicación…'
    );

    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const latitude = coords.latitude;
        const longitude = coords.longitude;

        this.showUserLocation(
          latitude,
          longitude
        );

        const orderedSpots = this.spots()
          .map((spot) => ({
            ...spot,
            distanceKm: this.calculateDistance(
              latitude,
              longitude,
              spot.lat,
              spot.lng
            ),
          }))
          .sort(
            (first, second) =>
              (first.distanceKm ?? 0) -
              (second.distanceKm ?? 0)
          );

        this.spots.set(orderedSpots);

        const nearestSpot = orderedSpots[0];

        if (nearestSpot) {
          this.locationStatus.set(
            `${nearestSpot.name} está a unos ` +
              `${nearestSpot.distanceKm?.toFixed(1)} km.`
          );

          this.selectSpot(nearestSpot);
        }

        this.locating.set(false);
      },
      (error) => {
        const message =
          error.code === error.PERMISSION_DENIED
            ? 'Debes permitir el acceso a tu ubicación.'
            : 'No pudimos obtener tu ubicación.';

        this.locationStatus.set(message);
        this.locating.set(false);
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 300000,
      }
    );
  }

  private applyResults(): void {
    this.syncMarkers();

    const visibleSpots =
      this.filteredSpots();

    if (visibleSpots.length === 0) {
      this.closeSheet(undefined, false);
      this.clearSpotUrl(false);
      return;
    }

    if (visibleSpots.length === 1) {
      this.selectSpot(visibleSpots[0]);
      return;
    }

    this.selectedSpot.set(null);
    this.sheetState.set('closed');
    this.sheetDragOffset.set(0);

    this.map?.closePopup();

    this.clearSpotUrl(false);
    this.updateMarkerStyles();
    this.fitVisibleMarkers();
  }

  private initializeMap(): void {
    if (!this.leaflet) {
      return;
    }

    this.map = this.leaflet
      .map('map', {
        zoomControl: false,
        attributionControl: true,
      })
      .setView([-33.45, -70.64], 11);

    this.leaflet
      .tileLayer(
        'https://{s}.basemaps.cartocdn.com/' +
          'light_all/{z}/{x}/{y}{r}.png',
        {
          attribution:
            '&copy; OpenStreetMap contributors ' +
            '&copy; CARTO',
          subdomains: 'abcd',
          maxZoom: 20,
        }
      )
      .addTo(this.map);

    this.leaflet.control
      .zoom({
        position: 'bottomright',
      })
      .addTo(this.map);
  }

  private createMarkers(): void {
    if (!this.map || !this.leaflet) {
      return;
    }

    this.spots().forEach((spot) => {
      const marker = this.leaflet!.marker(
        [spot.lat, spot.lng],
        {
          icon: this.createSpotIcon(false),
          title: spot.name,
          alt: `Ubicación de ${spot.name}`,
        }
      );

      marker.bindPopup(`
        <article class="raw-map-popup">
          <span>${this.formatType(spot.type)}</span>
          <strong>${spot.name}</strong>
          <small>${spot.commune}</small>
        </article>
      `);

      marker.on('click', () => {
        this.selectSpot(spot);
      });

      marker.addTo(this.map!);
      this.markers.set(spot.id, marker);
    });
  }

  private createSpotIcon(
    selected: boolean
  ): Leaflet.DivIcon {
    if (!this.leaflet) {
      throw new Error(
        'Leaflet no está disponible.'
      );
    }

    return this.leaflet.divIcon({
      className: 'raw-marker-wrapper',
      html: `
        <span
          class="raw-marker ${
            selected ? 'is-selected' : ''
          }"
          aria-hidden="true"
        >
          <span class="raw-marker-core"></span>
        </span>
      `,
      iconSize: selected
        ? [46, 46]
        : [38, 38],
      iconAnchor: selected
        ? [23, 23]
        : [19, 19],
      popupAnchor: [0, -22],
    });
  }

  private updateMarkerStyles(): void {
    const selectedId =
      this.selectedSpot()?.id;

    this.markers.forEach(
      (marker, id) => {
        marker.setIcon(
          this.createSpotIcon(
            id === selectedId
          )
        );

        marker.setZIndexOffset(
          id === selectedId
            ? 1000
            : 0
        );
      }
    );
  }

  private syncMarkers(): void {
    if (!this.map) {
      return;
    }

    const visibleIds = new Set(
      this.filteredSpots().map(
        (spot) => spot.id
      )
    );

    this.markers.forEach(
      (marker, id) => {
        if (visibleIds.has(id)) {
          marker.addTo(this.map!);
        } else {
          marker.removeFrom(this.map!);
        }
      }
    );
  }

  private fitVisibleMarkers(): void {
    if (!this.map || !this.leaflet) {
      return;
    }

    const visibleSpots =
      this.filteredSpots();

    if (visibleSpots.length === 0) {
      return;
    }

    if (visibleSpots.length === 1) {
      this.focusMapOnSpot(visibleSpots[0]);
      return;
    }

    const bounds =
      this.leaflet.latLngBounds(
        visibleSpots.map((spot) => [
          spot.lat,
          spot.lng,
        ])
      );

    this.map.fitBounds(bounds, {
      paddingTopLeft: [40, 150],
      paddingBottomRight: [40, 180],
      maxZoom: 13,
      animate: true,
    });
  }

  private focusMapOnSpot(
    spot: BoulderSpot
  ): void {
    if (!this.map) {
      return;
    }

    const latitudeOffset =
      this.sheetState() === 'expanded'
        ? 0.008
        : 0.004;

    this.map.flyTo(
      [
        spot.lat - latitudeOffset,
        spot.lng,
      ],
      15,
      {
        animate: true,
        duration: 0.65,
      }
    );
  }

  private updateMapPadding(): void {
    const spot = this.selectedSpot();

    if (!spot || !this.map) {
      return;
    }

    this.focusMapOnSpot(spot);
  }

  private showUserLocation(
    latitude: number,
    longitude: number
  ): void {
    if (!this.map || !this.leaflet) {
      return;
    }

    this.userLocation = {
      latitude,
      longitude,
    };

    this.userMarker?.remove();

    const userIcon =
      this.leaflet.divIcon({
        className:
          'raw-user-marker-wrapper',
        html: `
          <span class="raw-user-marker">
            <span></span>
          </span>
        `,
        iconSize: [34, 34],
        iconAnchor: [17, 17],
      });

    this.userMarker = this.leaflet
      .marker(
        [latitude, longitude],
        {
          icon: userIcon,
          title: 'Tu ubicación',
        }
      )
      .addTo(this.map)
      .bindPopup('Estás aquí');

    this.map.flyTo(
      [latitude, longitude],
      13,
      {
        animate: true,
        duration: 0.65,
      }
    );
  }

  private restoreSpotFromUrl(
    animate = true
  ): void {
    const params = new URLSearchParams(
      window.location.search
    );

    const spotSlug = params.get('spot');

    if (!spotSlug) {
      this.sheetState.set('closed');
      this.sheetDragOffset.set(0);
      this.selectedSpot.set(null);

      this.map?.closePopup();
      this.updateMarkerStyles();
      this.fitVisibleMarkers();

      return;
    }

    const spot = this.spots().find(
      (item) => item.slug === spotSlug
    );

    if (!spot) {
      this.sheetState.set('closed');
      this.selectedSpot.set(null);

      this.clearSpotUrl(false);
      this.updateMarkerStyles();
      this.fitVisibleMarkers();

      return;
    }

    this.selectedSpot.set(spot);
    this.sheetState.set('peek');
    this.sheetDragOffset.set(0);

    this.updateMarkerStyles();

    if (animate) {
      this.focusMapOnSpot(spot);
    } else {
      this.map?.setView(
        [
          spot.lat - 0.004,
          spot.lng,
        ],
        15
      );
    }

    window.setTimeout(() => {
      this.markers
        .get(spot.id)
        ?.openPopup();
    }, animate ? 420 : 50);
  }

  private updateSpotUrl(
    spot: BoulderSpot
  ): void {
    const url = new URL(
      window.location.href
    );

    if (
      url.searchParams.get('spot') ===
      spot.slug
    ) {
      return;
    }

    url.searchParams.set(
      'spot',
      spot.slug
    );

    window.history.pushState(
      {
        spot: spot.slug,
      },
      '',
      url
    );
  }

  private clearSpotUrl(
    pushHistory = true
  ): void {
    const url = new URL(
      window.location.href
    );

    if (!url.searchParams.has('spot')) {
      return;
    }

    url.searchParams.delete('spot');

    if (pushHistory) {
      window.history.pushState(
        {},
        '',
        url
      );
    } else {
      window.history.replaceState(
        {},
        '',
        url
      );
    }
  }

  private loadFavorites(): void {
    try {
      const storedFavorites =
        localStorage.getItem(
          'rawboulder-favorites'
        );

      if (!storedFavorites) {
        return;
      }

      const parsedFavorites =
        JSON.parse(storedFavorites);

      if (Array.isArray(parsedFavorites)) {
        this.favoriteIds.set(
          new Set(
            parsedFavorites.filter(
              (
                value
              ): value is string =>
                typeof value === 'string'
            )
          )
        );
      }
    } catch {
      this.favoriteIds.set(new Set());
    }
  }

  private persistFavorites(
    favorites: Set<string>
  ): void {
    try {
      localStorage.setItem(
        'rawboulder-favorites',
        JSON.stringify([...favorites])
      );
    } catch {
      this.showShareStatus(
        'No pudimos guardar el favorito.'
      );
    }
  }

  private getShareUrl(
    spot: BoulderSpot
  ): string {
    const url = new URL(
      window.location.origin +
        window.location.pathname
    );

    url.searchParams.set(
      'spot',
      spot.slug
    );

    return url.toString();
  }

  private showShareStatus(
    message: string
  ): void {
    this.shareStatus.set(message);

    window.setTimeout(() => {
      this.shareStatus.set('');
    }, 2500);
  }

  private calculateDistance(
    originLat: number,
    originLng: number,
    destinationLat: number,
    destinationLng: number
  ): number {
    const earthRadiusKm = 6371;

    const latitudeDifference =
      this.toRadians(
        destinationLat - originLat
      );

    const longitudeDifference =
      this.toRadians(
        destinationLng - originLng
      );

    const calculation =
      Math.sin(
        latitudeDifference / 2
      ) ** 2 +
      Math.cos(
        this.toRadians(originLat)
      ) *
        Math.cos(
          this.toRadians(
            destinationLat
          )
        ) *
        Math.sin(
          longitudeDifference / 2
        ) ** 2;

    return (
      earthRadiusKm *
      2 *
      Math.atan2(
        Math.sqrt(calculation),
        Math.sqrt(1 - calculation)
      )
    );
  }

  private toRadians(
    value: number
  ): number {
    return value * (Math.PI / 180);
  }

  private formatType(
    type: BoulderSpotType
  ): string {
    const labels: Record<
      BoulderSpotType,
      string
    > = {
      boulder: 'Boulder',
      muro: 'Muro',
      mixto: 'Mixto',
    };

    return labels[type];
  }
}