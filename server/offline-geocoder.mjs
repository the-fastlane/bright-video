import * as countryCoder from '@rapideditor/country-coder';
import cities from 'all-the-cities';

const cityGrid = new Map();
const cityCellSize = 1;
const maxCityDistanceKm = 50;
const maxRegionalCityDistanceKm = 25;
const majorCityPopulation = 100_000;
const earthRadiusKm = 6371;
const usStates = new Map([
  ['AL', 'Alabama'],
  ['AK', 'Alaska'],
  ['AZ', 'Arizona'],
  ['AR', 'Arkansas'],
  ['CA', 'California'],
  ['CO', 'Colorado'],
  ['CT', 'Connecticut'],
  ['DE', 'Delaware'],
  ['DC', 'District of Columbia'],
  ['FL', 'Florida'],
  ['GA', 'Georgia'],
  ['HI', 'Hawaii'],
  ['ID', 'Idaho'],
  ['IL', 'Illinois'],
  ['IN', 'Indiana'],
  ['IA', 'Iowa'],
  ['KS', 'Kansas'],
  ['KY', 'Kentucky'],
  ['LA', 'Louisiana'],
  ['ME', 'Maine'],
  ['MD', 'Maryland'],
  ['MA', 'Massachusetts'],
  ['MI', 'Michigan'],
  ['MN', 'Minnesota'],
  ['MS', 'Mississippi'],
  ['MO', 'Missouri'],
  ['MT', 'Montana'],
  ['NE', 'Nebraska'],
  ['NV', 'Nevada'],
  ['NH', 'New Hampshire'],
  ['NJ', 'New Jersey'],
  ['NM', 'New Mexico'],
  ['NY', 'New York'],
  ['NC', 'North Carolina'],
  ['ND', 'North Dakota'],
  ['OH', 'Ohio'],
  ['OK', 'Oklahoma'],
  ['OR', 'Oregon'],
  ['PA', 'Pennsylvania'],
  ['RI', 'Rhode Island'],
  ['SC', 'South Carolina'],
  ['SD', 'South Dakota'],
  ['TN', 'Tennessee'],
  ['TX', 'Texas'],
  ['UT', 'Utah'],
  ['VT', 'Vermont'],
  ['VA', 'Virginia'],
  ['WA', 'Washington'],
  ['WV', 'West Virginia'],
  ['WI', 'Wisconsin'],
  ['WY', 'Wyoming'],
]);

function cellKey(longitude, latitude) {
  return `${Math.floor(longitude / cityCellSize)}:${Math.floor(latitude / cityCellSize)}`;
}

for (const city of cities) {
  const [longitude, latitude] = city.loc.coordinates;
  const key = cellKey(longitude, latitude);
  const bucket = cityGrid.get(key);
  if (bucket) bucket.push(city);
  else cityGrid.set(key, [city]);
}

function distanceKm(longitudeA, latitudeA, longitudeB, latitudeB) {
  const latitudeDelta = ((latitudeB - latitudeA) * Math.PI) / 180;
  const longitudeDelta = ((longitudeB - longitudeA) * Math.PI) / 180;
  const latitudeARadians = (latitudeA * Math.PI) / 180;
  const latitudeBRadians = (latitudeB * Math.PI) / 180;
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latitudeARadians) * Math.cos(latitudeBRadians) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * earthRadiusKm * Math.asin(Math.sqrt(haversine));
}

function nearbyCities(longitude, latitude) {
  const nearby = [];
  const longitudeCell = Math.floor(longitude / cityCellSize);
  const latitudeCell = Math.floor(latitude / cityCellSize);
  for (let longitudeOffset = -1; longitudeOffset <= 1; longitudeOffset += 1) {
    for (let latitudeOffset = -1; latitudeOffset <= 1; latitudeOffset += 1) {
      const candidates = cityGrid.get(
        `${longitudeCell + longitudeOffset}:${latitudeCell + latitudeOffset}`,
      );
      for (const city of candidates ?? []) {
        const [cityLongitude, cityLatitude] = city.loc.coordinates;
        const distance = distanceKm(longitude, latitude, cityLongitude, cityLatitude);
        if (distance <= maxCityDistanceKm) nearby.push({ city, distance });
      }
    }
  }
  return nearby.sort((left, right) => left.distance - right.distance);
}

export function resolveOfflineLocation(latitude, longitude) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return [];
  if (Math.abs(latitude) < 0.000001 && Math.abs(longitude) < 0.000001) return [];

  const labels = [];
  const country = countryCoder.feature([longitude, latitude]);
  const countryName = country?.properties?.nameEn;
  if (countryName) labels.push(countryName);

  const nearby = nearbyCities(longitude, latitude);
  const city = nearby[0]?.city;
  if (city) {
    labels.unshift(city.name);
    const regionalCity = nearby.find(
      ({ city: candidate, distance }) =>
        candidate.name !== city.name &&
        distance <= maxRegionalCityDistanceKm &&
        candidate.population >= majorCityPopulation,
    )?.city;
    if (regionalCity) labels.unshift(regionalCity.name);
    const stateName = city.country === 'US' ? usStates.get(city.adminCode) : null;
    if (stateName) labels.splice(1, 0, stateName);
  }

  return [...new Set(labels)];
}
