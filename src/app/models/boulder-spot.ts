export type BoulderSpotType = 'boulder' | 'muro' | 'mixto';

export interface BoulderSpot {
  id: string;
  slug: string;

  name: string;
  type: BoulderSpotType;

  commune: string;
  address: string;

  lat: number;
  lng: number;

  instagram?: string;
  website?: string;
  googleMaps: string;

  price?: string;
  schedule?: string;

  visited: boolean;
  featured?: boolean;

  tags: string[];

  distanceKm?: number;
}