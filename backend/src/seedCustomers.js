import 'dotenv/config';
import mongoose from 'mongoose';
import { Customer, Device } from './models.js';
import { assessDeviceRegion } from './b2c/deviceRegion.js';

// Adds 20 fictional B2C customers, each with the device they bought, for testing
// serial-number lookup and B2C regional routing. Safe to run again: records that
// already exist are skipped, and existing records are never changed or deleted.
//
// A customer's purchase is recorded on its Device: `purchaseDate`, and `location`,
// which is the region the device was bought in and the region B2C routes to.
//
// Serial numbers are TESTMOB0001–TESTMOB0020: 8–14 letters and digits, so the B2C
// "Serial No" email rule picks them up. Phone numbers are +91 followed by ten
// digits starting with 0, which is not a valid Indian mobile number, and emails
// use example.com, so no real customer can be contacted.
//
// Usage: npm run seed:customers -- --database=<name of the database in MONGODB_URI>

const COUNT = 20;
const MARKER = 'TESTMOB';
const names = ['Aarav Sharma', 'Diya Patel', 'Vihaan Reddy', 'Ananya Gupta', 'Arjun Nair', 'Ishaan Verma', 'Saanvi Iyer', 'Kabir Singh', 'Myra Joshi', 'Reyansh Das',
  'Aadhya Menon', 'Vivaan Rao', 'Kiara Pillai', 'Advik Bose', 'Navya Kulkarni', 'Shaurya Mehta', 'Anika Chatterjee', 'Dhruv Hegde', 'Tara Banerjee', 'Rohan Shetty'];
const models = ['iPhone 15', 'iPhone 15 Pro', 'iPhone 16', 'iPhone 16 Pro', 'iPhone 16 Pro Max'];
const pad = (value, size) => String(value).padStart(size, '0');
const addDays = (date, days) => new Date(date.getTime() + days * 86400000);

function fail(message) {
  console.error(`Seed stopped: ${message}`);
  process.exit(1);
}

const confirmed = process.argv.find(arg => arg.startsWith('--database='))?.slice('--database='.length);
if (process.env.NODE_ENV === 'production') fail('NODE_ENV is production. Test customers are never added to production.');
if (!process.env.MONGODB_URI) fail('MONGODB_URI is not set.');
if (!confirmed) fail('name the target database to confirm it is a development/test database, e.g. npm run seed:customers -- --database=iplanet_portal');

await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
const database = mongoose.connection.name;
if (database !== confirmed) {
  await mongoose.disconnect();
  fail(`MONGODB_URI connects to "${database}", not "${confirmed}".`);
}
await Promise.all([Device.init(), Customer.init()]);

// Purchase regions are the regions already defined on device records (the same list
// B2C triage offers). None are invented: with no regions there is nothing to route to.
const regions = (await Device.distinct('location', { serialNumber: { $not: new RegExp(`^${MARKER}`) } }))
  .map(name => (typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '')).filter(Boolean).sort();
if (!regions.length) {
  await mongoose.disconnect();
  fail('no device records define a region (Device.location). Add devices with regions first.');
}

const firstPurchase = new Date('2026-01-05T00:00:00Z');
const records = names.slice(0, COUNT).map((name, index) => {
  const number = index + 1;
  const serialNumber = `${MARKER}${pad(number, 4)}`;
  const purchaseDate = addDays(firstPurchase, index * 9);
  return {
    device: { serialNumber, assetId: `TEST-MOB-${pad(number, 4)}`, deviceType: 'iPhone', model: models[index % models.length], location: regions[index % regions.length], purchaseDate, warrantyStatus: 'Active', warrantyExpiry: addDays(purchaseDate, 365), deviceStatus: 'Active', deviceAllocationStatus: 'Unassigned' },
    customer: { name, mobileNumber: `+9100000000${pad(number, 2)}`, email: `test.customer${pad(number, 2)}@example.com`, deviceSerialNumber: serialNumber },
  };
});

const counts = { inserted: { devices: 0, customers: 0 }, skipped: { devices: 0, customers: 0 }, failed: 0 };
const failures = [];
for (const { device, customer } of records) {
  let createdDevice = null;
  try {
    const existingDevice = await Device.findOne({ serialNumber: device.serialNumber }).lean();
    if (existingDevice && existingDevice.assetId !== device.assetId) throw new Error(`serial number ${device.serialNumber} already belongs to a device that this seed did not create`);
    if (existingDevice) counts.skipped.devices += 1;
    else { createdDevice = await Device.create(device); counts.inserted.devices += 1; }

    const existingCustomer = await Customer.findOne({ deviceSerialNumber: device.serialNumber }).lean();
    if (existingCustomer && existingCustomer.email !== customer.email) throw new Error(`a different customer already has device ${device.serialNumber}`);
    if (existingCustomer) counts.skipped.customers += 1;
    else { await Customer.create(customer); counts.inserted.customers += 1; }
  } catch (error) {
    // Undo only the device created in this run, so a failed customer leaves no orphan.
    if (createdDevice) { await Device.deleteOne({ _id: createdDevice._id }); counts.inserted.devices -= 1; }
    counts.failed += 1;
    failures.push(`${device.serialNumber}: ${error.message}`);
  }
}

// Check every chain Customer → Device → purchase region, as B2C routing would see it.
const problems = [...failures];
for (const { device: expected } of records) {
  const devices = await Device.find({ serialNumber: expected.serialNumber }).lean();
  const customers = await Customer.find({ deviceSerialNumber: expected.serialNumber }).lean();
  if (devices.length !== 1) problems.push(`${expected.serialNumber}: ${devices.length} device records`);
  if (customers.length !== 1) problems.push(`${expected.serialNumber}: ${customers.length} customers`);
  if (customers.some(item => !Number.isInteger(item.customerId))) problems.push(`${expected.serialNumber}: customer has no customerId`);
  const region = assessDeviceRegion({ identifiers: [{ type: 'serialNumber', value: expected.serialNumber }], devices });
  if (region.status !== 'automatic' || !regions.includes(region.region)) problems.push(`${expected.serialNumber}: B2C would not route it to a known region (${region.reason || region.region})`);
}
const deviceIndexes = await Device.collection.indexes();
const customerIndexes = await Customer.collection.indexes();
if (!deviceIndexes.some(index => index.key.serialNumber === 1 && index.unique)) problems.push('devices: unique serialNumber index is missing');
if (!customerIndexes.some(index => index.key.customerId === 1 && index.unique)) problems.push('customers: unique customerId index is missing');

const seeded = await Customer.find({ deviceSerialNumber: new RegExp(`^${MARKER}`) }).sort({ customerId: 1 }).lean();
const regionOf = new Map((await Device.find({ serialNumber: new RegExp(`^${MARKER}`) }).lean()).map(item => [item.serialNumber, item.location]));
console.log('====================================');
console.log(`Test customer seed: ${database}`);
console.log('====================================');
console.log(`Inserted: ${counts.inserted.customers} customers, ${counts.inserted.devices} devices`);
console.log(`Skipped:  ${counts.skipped.customers} customers, ${counts.skipped.devices} devices (already present)`);
console.log(`Failed:   ${counts.failed}`);
console.log('');
for (const item of seeded) console.log(`${pad(item.customerId, 3)}  ${item.deviceSerialNumber}  ${regionOf.get(item.deviceSerialNumber) || '-'}  ${item.name}  ${item.mobileNumber}  ${item.email}`);
console.log('');
if (problems.length) {
  console.log(`Validation FAILED (${problems.length}):`);
  for (const problem of problems) console.log(`  - ${problem}`);
} else console.log(`All ${COUNT} customers validated: each has one device with a purchase region B2C can route to.`);
console.log('====================================');
await mongoose.disconnect();
if (problems.length) process.exitCode = 1;
