// Coordinate validation and straight-line distance for the live GPS viewer.
export function isValidPosition(value) {
    return value !== null && typeof value === 'object' &&
        Number.isFinite(value.lat) && value.lat >= -90 && value.lat <= 90 &&
        Number.isFinite(value.lng) && value.lng >= -180 && value.lng <= 180;
}

export function distanceMeters(a, b) {
    if (!isValidPosition(a) || !isValidPosition(b)) {
        throw new TypeError('Expected finite numeric latitude and longitude.');
    }
    const radians = Math.PI / 180;
    const latitudeDelta = (b.lat - a.lat) * radians;
    const longitudeDelta = (b.lng - a.lng) * radians;
    const haversine = Math.sin(latitudeDelta / 2) ** 2 +
        Math.cos(a.lat * radians) * Math.cos(b.lat * radians) *
        Math.sin(longitudeDelta / 2) ** 2;
    return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, haversine))));
}
