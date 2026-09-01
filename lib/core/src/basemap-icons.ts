// The thumbnails the basemap picker draws. `ProviderViewModel` throws when `iconUrl` is absent, and
// `@cesium/widgets` ships no provider icons, so each known Earth basemap carries its own.
//
// They are inlined as `data:` URIs rather than served. A URL under `baseUrl` would need a second
// rebasing path beside `lib/vscode/imagery.ts`, and the four hosts each resolve `baseUrl`
// differently. A `data:` URI is identical in every host, and `img-src` already allows one.
//
// Each icon is 64 px, cut from that source's own level-2 tile over the same window — Europe, north
// Africa and west Asia — so the six differ by what the source draws and by nothing else. GIBS
// spells a tile path `{z}/{y}/{x}` and EMODnet spells it `{z}/{x}/{y}`, so the two path forms below
// name the same square of the Earth:
//
//   offline_natural_earth  the pyramid in @cesium/engine, Source/Assets/Textures/NaturalEarthII
//   aster_colour_relief    GIBS ASTER_GDEM_Color_Shaded_Relief, GoogleMapsCompatible_Level12/2/1/2
//   aster_grey_relief      GIBS ASTER_GDEM_Greyscale_Shaded_Relief, GoogleMapsCompatible_Level12/2/1/2
//   emodnet_baselayer      tiles.emodnet-bathymetry.eu, 2020/baselayer/web_mercator/2/2/1
//   blue_marble            GIBS BlueMarble_ShadedRelief_Bathymetry, GoogleMapsCompatible_Level8/2/1/2
//   blue_marble_relief     GIBS BlueMarble_ShadedRelief, GoogleMapsCompatible_Level8/2/1/2

import asterColourRelief from "./icons/aster_colour_relief.icon.png";
import asterGreyRelief from "./icons/aster_grey_relief.icon.png";
import blueMarble from "./icons/blue_marble.icon.png";
import blueMarbleRelief from "./icons/blue_marble_relief.icon.png";
import emodnetBaselayer from "./icons/emodnet_baselayer.icon.png";
import offlineNaturalEarth from "./icons/offline_natural_earth.icon.png";

/** One icon per key of Julia's `KNOWN_EARTH_BASEMAPS`. */
export const BASEMAP_ICONS = {
  offline_natural_earth: offlineNaturalEarth,
  aster_colour_relief: asterColourRelief,
  aster_grey_relief: asterGreyRelief,
  emodnet_baselayer: emodnetBaselayer,
  blue_marble: blueMarble,
  blue_marble_relief: blueMarbleRelief,
} as const;

/** A key of {@link BASEMAP_ICONS}. */
export type BasemapIconKey = keyof typeof BASEMAP_ICONS;
