export interface DecodedPoint {
  latitude: number;
  longitude: number;
}

/**
 * Decodes a Google Encoded Polyline Algorithm Format string (precision 5,
 * as used by OneMap's `route_geometry`/`legGeometry.points`) into a list of
 * WGS84 lat/long points.
 */
export function decodePolyline(encoded: string): DecodedPoint[] {
  const factor = 1e5;
  let index = 0;
  let lat = 0;
  let lng = 0;
  const points: DecodedPoint[] = [];

  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    shift = 0;
    result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    points.push({ latitude: lat / factor, longitude: lng / factor });
  }

  return points;
}
