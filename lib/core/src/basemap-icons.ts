// The thumbnails the basemap picker draws. `ProviderViewModel` throws when `iconUrl` is absent, and
// `@cesium/widgets` ships no provider icons, so each known Earth basemap carries its own.
//
// They are inlined as `data:` URIs rather than served. A URL under `baseUrl` would need a second
// rebasing path beside `lib/vscode/imagery.ts`, and the four hosts each resolve `baseUrl`
// differently. A `data:` URI is identical in every host, and `img-src` already allows one.
//
// Each icon is 64 px, cut from that source's own level-2 tile over the same window — Europe, north
// Africa and west Asia — so the four differ by what the source draws and by nothing else:
//
//   offline_natural_earth  the pyramid in @cesium/engine, Source/Assets/Textures/NaturalEarthII
//   blue_marble            GIBS BlueMarble_ShadedRelief_Bathymetry, GoogleMapsCompatible_Level8/2/1/2
//   blue_marble_relief     GIBS BlueMarble_ShadedRelief, GoogleMapsCompatible_Level8/2/1/2
//   blue_marble_labeled    freetiler/nasa-bluemarble-labeled over jsDelivr, tiles/2/2/1

import blueMarble from "./icons/blue_marble.icon.png";
import blueMarbleLabeled from "./icons/blue_marble_labeled.icon.png";
import blueMarbleRelief from "./icons/blue_marble_relief.icon.png";
import offlineNaturalEarth from "./icons/offline_natural_earth.icon.png";

/** One icon per key of Julia's `KNOWN_EARTH_BASEMAPS`. */
export const BASEMAP_ICONS = {
  offline_natural_earth: offlineNaturalEarth,
  blue_marble: blueMarble,
  blue_marble_relief: blueMarbleRelief,
  blue_marble_labeled: blueMarbleLabeled,
} as const;

/** A key of {@link BASEMAP_ICONS}. */
export type BasemapIconKey = keyof typeof BASEMAP_ICONS;
