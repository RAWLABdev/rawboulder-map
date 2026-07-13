import { isPlatformBrowser } from '@angular/common';
import {
  AfterViewInit,
  Component,
  computed,
  Inject,
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

@Component({
  selector: 'app-boulder-map',
  standalone: true,
  templateUrl: './boulder-map.html',
  styleUrl: './boulder-map.css',
})
export class BoulderMapComponent implements AfterViewInit {
  readonly spots = signal<BoulderSpot[]>(BOULDER_SPOTS);

  readonly query = signal('');
  readonly activeFilter = signal<SpotFilter>('all');
  readonly selectedSpot = signal<BoulderSpot | null>(null);

  readonly locating = signal(false);
  readonly locationStatus = signal('');

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

  private map?: Leaflet.Map;
  private leaflet?: typeof Leaflet;
  private userMarker?: Leaflet.Marker;

  private readonly markers = new Map<
    string,
    Leaflet.Marker
  >();

  constructor(
    @Inject(PLATFORM_ID)
    private readonly platformId: object
  ) {}

  async ngAfterViewInit(): Promise<void> {
    if (!isPlatformBrowser(this.platformId)) {
      return;
    }

    this.leaflet = await import('leaflet');

    this.initializeMap();
    this.createMarkers();

    window.setTimeout(() => {
      this.map?.invalidateSize();
    });
  }

  onSearch(event: Event): void {
    const input = event.target as HTMLInputElement;

    this.query.set(input.value);
    this.syncMarkers();
  }

  clearSearch(): void {
    this.query.set('');
    this.syncMarkers();
  }

  setFilter(filter: SpotFilter): void {
    this.activeFilter.set(filter);
    this.selectedSpot.set(null);

    this.syncMarkers();
    this.fitVisibleMarkers();
  }

  focusSpot(spot: BoulderSpot): void {
    this.selectedSpot.set(spot);

    this.updateMarkerStyles();

    this.map?.flyTo([spot.lat, spot.lng], 15, {
      animate: true,
      duration: 0.7,
    });

    window.setTimeout(() => {
      this.markers.get(spot.id)?.openPopup();
    }, 500);
  }

  findNearestSpot(): void {
    if (!navigator.geolocation) {
      this.locationStatus.set(
        'Tu navegador no permite utilizar la ubicación.'
      );

      return;
    }

    this.locating.set(true);
    this.locationStatus.set('Buscando tu ubicación…');

    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const latitude = coords.latitude;
        const longitude = coords.longitude;

        this.showUserLocation(latitude, longitude);

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
            `${nearestSpot.name} está aproximadamente a ${nearestSpot.distanceKm?.toFixed(1)} km.`
          );

          this.focusSpot(nearestSpot);
        }

        this.locating.set(false);
      },
      () => {
        this.locationStatus.set(
          'No pudimos acceder a tu ubicación. Revisa los permisos del navegador.'
        );

        this.locating.set(false);
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 300000,
      }
    );
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
      'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
      {
        attribution:
          '&copy; OpenStreetMap contributors &copy; CARTO',
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
        this.selectedSpot.set(spot);
        this.updateMarkerStyles();
      });

      marker.addTo(this.map!);
      this.markers.set(spot.id, marker);
    });
  }

  private createSpotIcon(
    selected: boolean
  ): Leaflet.DivIcon {
    if (!this.leaflet) {
      throw new Error('Leaflet no está disponible.');
    }

    return this.leaflet.divIcon({
      className: 'raw-marker-wrapper',
      html: `
        <span
          class="raw-marker ${selected ? 'is-selected' : ''}"
          aria-hidden="true"
        >
          <span class="raw-marker-core"></span>
        </span>
      `,
      iconSize: selected ? [46, 46] : [38, 38],
      iconAnchor: selected ? [23, 23] : [19, 19],
      popupAnchor: [0, -22],
    });
  }

  private updateMarkerStyles(): void {
    const selectedId = this.selectedSpot()?.id;

    this.markers.forEach((marker, id) => {
      marker.setIcon(
        this.createSpotIcon(id === selectedId)
      );

      marker.setZIndexOffset(
        id === selectedId ? 1000 : 0
      );
    });
  }

  private syncMarkers(): void {
    if (!this.map) {
      return;
    }

    const visibleIds = new Set(
      this.filteredSpots().map((spot) => spot.id)
    );

    this.markers.forEach((marker, id) => {
      if (visibleIds.has(id)) {
        marker.addTo(this.map!);
      } else {
        marker.removeFrom(this.map!);
      }
    });
  }

  private fitVisibleMarkers(): void {
    if (!this.map || !this.leaflet) {
      return;
    }

    const visibleSpots = this.filteredSpots();

    if (visibleSpots.length === 0) {
      return;
    }

    if (visibleSpots.length === 1) {
      this.focusSpot(visibleSpots[0]);
      return;
    }

    const bounds = this.leaflet.latLngBounds(
      visibleSpots.map((spot) => [
        spot.lat,
        spot.lng,
      ])
    );

    this.map.fitBounds(bounds, {
      padding: [70, 70],
      maxZoom: 13,
      animate: true,
    });
  }

  private showUserLocation(
    latitude: number,
    longitude: number
  ): void {
    if (!this.map || !this.leaflet) {
      return;
    }

    this.userMarker?.remove();

    const userIcon = this.leaflet.divIcon({
      className: 'raw-user-marker-wrapper',
      html: `
        <span class="raw-user-marker">
          <span></span>
        </span>
      `,
      iconSize: [34, 34],
      iconAnchor: [17, 17],
    });

    this.userMarker = this.leaflet
      .marker([latitude, longitude], {
        icon: userIcon,
        title: 'Tu ubicación',
      })
      .addTo(this.map)
      .bindPopup('Estás aquí');

    this.map.flyTo([latitude, longitude], 13, {
      animate: true,
      duration: 0.7,
    });
  }

  private calculateDistance(
    originLat: number,
    originLng: number,
    destinationLat: number,
    destinationLng: number
  ): number {
    const earthRadiusKm = 6371;

    const latitudeDifference = this.toRadians(
      destinationLat - originLat
    );

    const longitudeDifference = this.toRadians(
      destinationLng - originLng
    );

    const calculation =
      Math.sin(latitudeDifference / 2) ** 2 +
      Math.cos(this.toRadians(originLat)) *
        Math.cos(this.toRadians(destinationLat)) *
        Math.sin(longitudeDifference / 2) ** 2;

    return (
      earthRadiusKm *
      2 *
      Math.atan2(
        Math.sqrt(calculation),
        Math.sqrt(1 - calculation)
      )
    );
  }

  private toRadians(value: number): number {
    return value * (Math.PI / 180);
  }

  private formatType(
    type: BoulderSpotType
  ): string {
    const labels: Record<BoulderSpotType, string> = {
      boulder: 'Boulder',
      muro: 'Muro',
      mixto: 'Mixto',
    };

    return labels[type];
  }
}