// Sample listings so the app has something to show before real apartments
// join. Every name here is made up and marked "sample: true". They carry no
// phone number, so nobody can be contacted by mistake.
//
// Locations are approximate centres of real Bengaluru areas. Test dates are
// set relative to today so the samples do not go stale.

function daysAgo(days, today) {
  return new Date(today.getTime() - days * 86400000).toISOString().slice(0, 10);
}

export function sampleSupplies(today = new Date()) {
  const base = [
    { id: 'sample-jakkur-1', name: 'Sample Lakeview Residency', area: 'Jakkur', lat: 13.0795, lng: 77.6085, surplusKld: 90, pricePerKl: 10, delivery: 'pickup',
      quality: { ph: 7.2, bod: 6, cod: 32, tss: 9, fc: 80, chloride: 180, sulphate: 95 }, age: 12 },
    { id: 'sample-jakkur-2', name: 'Sample Green Meadows', area: 'Jakkur', lat: 13.0712, lng: 77.6001, surplusKld: 45, pricePerKl: 8, delivery: 'pickup',
      quality: { ph: 7.6, bod: 8, cod: 41, tss: 14, fc: 150 }, age: 25 },
    { id: 'sample-yelahanka-1', name: 'Sample Palm Heights', area: 'Yelahanka', lat: 13.1002, lng: 77.5968, surplusKld: 120, pricePerKl: 12, delivery: 'pipeline',
      quality: { ph: 7.0, bod: 5, cod: 28, tss: 7, fc: 40, chloride: 140, sulphate: 70 }, age: 8 },
    { id: 'sample-hebbal-1', name: 'Sample Skyline Towers', area: 'Hebbal', lat: 13.0372, lng: 77.5991, surplusKld: 60, pricePerKl: 10, delivery: 'pickup',
      quality: { ph: 7.9, bod: 16, cod: 72, tss: 28, fc: 900 }, age: 20 },
    { id: 'sample-hennur-1', name: 'Sample Orchard Park', area: 'Hennur', lat: 13.0415, lng: 77.6448, surplusKld: 35, pricePerKl: 9, delivery: 'pickup',
      quality: { ph: 7.4, bod: 7, cod: 36, tss: 11, fc: 110, chloride: 620, sulphate: 110 }, age: 140 },
    { id: 'sample-whitefield-1', name: 'Sample Tech Park Homes', area: 'Whitefield', lat: 12.9712, lng: 77.7488, surplusKld: 150, pricePerKl: 12, delivery: 'pickup',
      quality: { ph: 7.1, bod: 5, cod: 30, tss: 8, fc: 60, chloride: 210, sulphate: 120 }, age: 15 },
    { id: 'sample-whitefield-2', name: 'Sample Garden Enclave', area: 'Whitefield', lat: 12.9641, lng: 77.7402, surplusKld: 50, pricePerKl: 10, delivery: 'pickup',
      quality: { ph: 6.9, bod: 9, cod: 44, tss: 16, fc: 200 }, age: 30 },
    { id: 'sample-bellandur-1', name: 'Sample Lakeside Square', area: 'Bellandur', lat: 12.9289, lng: 77.6772, surplusKld: 100, pricePerKl: 11, delivery: 'pickup',
      quality: { ph: 7.3, bod: 6, cod: 35, tss: 10, fc: 90, chloride: 260, sulphate: 140 }, age: 18 },
    { id: 'sample-sarjapur-1', name: 'Sample Meadow Woods', area: 'Sarjapur Road', lat: 12.9105, lng: 77.6862, surplusKld: 75, pricePerKl: 9, delivery: 'pipeline',
      quality: { ph: 7.5, bod: 8, cod: 40, tss: 13, fc: 120, chloride: 300, sulphate: 160 }, age: 22 },
    { id: 'sample-ecity-1', name: 'Sample Silicon Homes', area: 'Electronic City', lat: 12.8461, lng: 77.6612, surplusKld: 80, pricePerKl: 10, delivery: 'pickup',
      quality: { ph: 7.2, bod: 7, cod: 38, tss: 12, fc: 100, chloride: 230, sulphate: 130 }, age: 10 },
  ];

  return base.map(({ age, ...supply }) => ({
    ...supply,
    testDate: daysAgo(age, today),
    contactName: 'Sample listing',
    phone: '',
    sample: true,
    reportStatus: 'none',
    createdAt: today.toISOString(),
    updatedAt: today.toISOString(),
  }));
}

// Sample requests from construction sites, also made up and marked as samples.
export function sampleRequests(today = new Date()) {
  const base = [
    { id: 'sample-site-1', siteName: 'Sample Metro Viaduct Works', area: 'Yelahanka', lat: 13.0921, lng: 77.5902, needKld: 80, use: 'dust', age: 2 },
    { id: 'sample-site-2', siteName: 'Sample Residential Tower Site', area: 'Whitefield', lat: 12.9755, lng: 77.7421, needKld: 45, use: 'curing', age: 5 },
    { id: 'sample-site-3', siteName: 'Sample Road Widening Project', area: 'Sarjapur Road', lat: 12.9048, lng: 77.6911, needKld: 60, use: 'dust', age: 1 },
  ];
  return base.map(({ age, ...request }) => ({
    ...request,
    contactName: 'Sample request',
    phone: '',
    sample: true,
    createdAt: new Date(today.getTime() - age * 86400000).toISOString(),
    // Samples never expire.
    expiresAt: Math.floor(today.getTime() / 1000) + 3650 * 86400,
  }));
}
