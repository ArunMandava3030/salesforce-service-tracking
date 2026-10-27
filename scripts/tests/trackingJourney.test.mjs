import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../../force-app/main/default/lwc/trackingJourney/trackingJourney.js', import.meta.url), 'utf8');
const { distanceMeters } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const customer = { lat: 37.7749, lng: -122.4194 };

test('distance to the same customer coordinates is zero without mutating either location', () => {
    const phone = Object.freeze({ ...customer });
    const destination = Object.freeze({ ...customer });
    assert.equal(distanceMeters(phone, destination), 0);
    assert.deepEqual(phone, customer);
    assert.deepEqual(destination, customer);
});

test('haversine returns known equatorial distances in meters', () => {
    assert.ok(Math.abs(distanceMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 1 }) - 111194.9266) < 0.1);
    assert.ok(Math.abs(distanceMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 180 }) - 20015086.796) < 0.1);
});

test('phone-to-customer distance is symmetric and uses the short path across the date line', () => {
    const phone = { lat: 37.7739, lng: -122.4204 };
    const forward = distanceMeters(phone, customer);
    assert.ok(forward > 140 && forward < 160);
    assert.equal(forward, distanceMeters(customer, phone));
    const dateLine = distanceMeters({ lat: 0, lng: 179.9 }, { lat: 0, lng: -179.9 });
    assert.ok(Math.abs(dateLine - 22238.9853) < 0.1);
});

test('valid geographic boundaries produce finite nonnegative distances', () => {
    for (const point of [{ lat: -90, lng: -180 }, { lat: 90, lng: 180 }, { lat: 0, lng: 0 }]) {
        const distance = distanceMeters(point, customer);
        assert.ok(Number.isFinite(distance));
        assert.ok(distance >= 0 && distance <= 20015087);
    }
});

test('either invalid location is rejected instead of being coerced into plausible coordinates', () => {
    for (const value of [null, undefined, {}, [], '0,0', { lat: '0', lng: 0 },
        { lat: 0, lng: '0' }, { lat: true, lng: 0 }, { lat: 0, lng: false },
        { lat: NaN, lng: 0 }, { lat: 0, lng: Infinity },
        { lat: -Infinity, lng: 0 }, { lat: 90.1, lng: 0 }, { lat: -90.1, lng: 0 },
        { lat: 0, lng: 180.1 }, { lat: 0, lng: -180.1 }]) {
        assert.throws(() => distanceMeters(value, customer), TypeError);
        assert.throws(() => distanceMeters(customer, value), TypeError);
    }
});
