import 'dotenv/config';
import mongoose from 'mongoose';
import { User, Company, Device, DeviceMaster, Engineer, Ticket, TicketTimeline, Notification } from './models.js';
import { demoEnrollmentDevices } from './demoData.js';

const locations = ['Chennai', 'Coimbatore', 'Bengaluru', 'Madurai'];
const models = ['iPhone 15 Pro', 'iPhone 15', 'iPhone 14', 'iPhone 13', 'MacBook Pro 14', 'MacBook Air M2', 'iPad Pro 12.9', 'iPad Air'];
const people = ['Arun Kumar', 'Meera Iyer', 'Ravi Shankar', 'Nisha Rao', 'Karthik S'];
const statuses = ['Open', 'Engineer Assigned', 'Engineer Accepted', 'In Progress', 'Waiting for Parts', 'Completed', 'Closed'];
await mongoose.connect(process.env.MONGODB_URI);
await Promise.all([User.deleteMany({}), Company.deleteMany({}), Device.deleteMany({}), DeviceMaster.deleteMany({}), Engineer.deleteMany({}), Ticket.deleteMany({}), TicketTimeline.deleteMany({}), Notification.deleteMany({})]);

const companies = await Company.insertMany([
  { name: 'ABC Technologies', companyId: 'CO-001', contactName: 'Arun Kumar', contactEmail: 'admin@corporate.local', phone: '+91 90000 00000', location: 'Chennai' },
  { name: 'XYZ Solutions', companyId: 'CO-002', contactName: 'Priya Shah', contactEmail: 'admin2@corporate.local', phone: '+91 90000 00001', location: 'Bengaluru' },
  { name: 'Demo Corporation', companyId: 'CO-003', contactName: 'Kiran Rao', contactEmail: 'admin3@corporate.local', phone: '+91 90000 00002', location: 'Coimbatore' }
]);
const customer = await User.create({ name: 'Arun Kumar', email: 'admin@corporate.local', password: 'Demo@123', role: 'corporate_admin', company: companies[0].name, companyId: companies[0]._id, phone: companies[0].phone });
await User.create({ name: 'Priya Shah', email: 'admin2@corporate.local', password: 'Demo@123', role: 'corporate_admin', company: companies[1].name, companyId: companies[1]._id, phone: companies[1].phone });
await User.create({ name: 'Kiran Rao', email: 'admin3@corporate.local', password: 'Demo@123', role: 'corporate_admin', company: companies[2].name, companyId: companies[2]._id, phone: companies[2].phone });
const serviceUser = await User.create({ name: 'Neha Menon', email: 'service@iplanet.local', password: 'Demo@123', role: 'iplanet_service', company: 'iPlanet Service Desk', phone: '+91 90000 00002' });
const engineerUsers = await User.insertMany([
  { name: 'Vikram S', email: 'engineer1@iplanet.local', password: 'Demo@123', role: 'iplanet_service', company: 'iPlanet Service Desk', phone: '+91 90000 00003' },
  { name: 'Priya Menon', email: 'engineer2@iplanet.local', password: 'Demo@123', role: 'iplanet_service', company: 'iPlanet Service Desk', phone: '+91 90000 00004' },
  { name: 'Sanjay Rao', email: 'engineer3@iplanet.local', password: 'Demo@123', role: 'iplanet_service', company: 'iPlanet Service Desk', phone: '+91 90000 00005' },
  { name: 'Kavya Iyer', email: 'engineer4@iplanet.local', password: 'Demo@123', role: 'iplanet_service', company: 'iPlanet Service Desk', phone: '+91 90000 00006' },
  { name: 'Rohan Das', email: 'engineer5@iplanet.local', password: 'Demo@123', role: 'iplanet_service', company: 'iPlanet Service Desk', phone: '+91 90000 00007' }
]);
const engineers = await Engineer.insertMany(engineerUsers.map((user, index) => ({ name: user.name, employeeId: `SE-${2001 + index}`, email: user.email, phone: user.phone, location: locations[index % locations.length], status: index === 4 ? 'Offline' : index % 2 ? 'Busy' : 'Available', userId: user._id })));
const devices = await Device.insertMany(Array.from({ length: 20 }, (_, index) => ({ assetId: `AST-${String(index + 1).padStart(3, '0')}`, serialNumber: `APL-DEMO-${String(index + 1).padStart(4, '0')}`, deviceType: models[index % models.length].startsWith('iPhone') ? 'iPhone' : models[index % models.length].startsWith('iPad') ? 'iPad' : 'MacBook', model: models[index % models.length], companyId: companies[index % companies.length]._id, employeeName: index % 7 === 0 ? null : people[index % people.length], employeeId: index % 7 === 0 ? null : `EMP-${1001 + index}`, department: index % 7 === 0 ? null : ['IT', 'Finance', 'Operations', 'Sales'][index % 4], location: locations[index % 4], purchaseDate: new Date(2023, index % 12, 10), warrantyStatus: index % 5 === 0 ? 'Expired' : index % 4 === 0 ? 'Expiring Soon' : 'Active', warrantyExpiry: new Date(2026 + (index % 2), index % 12, 20), amcStatus: index % 4 === 1 ? 'Expired' : index % 3 === 0 ? 'Expiring Soon' : 'Active', amcExpiry: new Date(2027, (index + 3) % 12, 15), deviceStatus: index % 6 === 0 ? 'Under Service' : 'In Use', deviceAllocationStatus: index % 7 === 0 ? 'Unassigned' : 'Assigned', lastServiceDate: new Date(2025, index % 12, 4) })));
await DeviceMaster.insertMany([
  ...demoEnrollmentDevices,
  ...devices.slice(0, 5).map(device => ({ serialNumber: device.serialNumber, deviceType: device.deviceType, model: device.model, assetId: device.assetId, purchaseDate: device.purchaseDate, warrantyStatus: device.warrantyStatus, warrantyExpiry: device.warrantyExpiry, amcStatus: device.amcStatus, amcExpiry: device.amcExpiry }))
]);
const tickets = await Ticket.insertMany(Array.from({ length: 18 }, (_, index) => { const status = statuses[index % statuses.length]; const assigned = index % 3 === 0 ? null : engineers[index % engineers.length]; const company = companies[index % companies.length]; const companyCustomer = company._id.equals(companies[0]._id) ? customer : null; return { ticketId: index === 0 ? 'SR-1024' : `SR-${1025 + index}`, customerId: companyCustomer?._id || customer._id, companyId: company._id, deviceId: devices[index % devices.length]._id, category: 'Service Request', issueType: ['Battery', 'Screen / Display', 'Charging', 'Performance', 'Keyboard'][index % 5], description: 'Demo service issue requiring technician inspection.', images: [], location: locations[index % 4], preferredServiceDate: new Date(2026, 8, 12 + (index % 10)), priority: ['Low', 'Medium', 'High', 'Critical'][index % 4], status, assignedEngineer: assigned?.name || 'Unassigned', assignedEngineerId: assigned?._id, assignedAt: assigned ? new Date(2026, 8, 9, 9 + (index % 5), 30) : undefined, expectedTAT: `${1 + (index % 4)} business days`, createdAt: new Date(2026, 7, 1 + index), updatedAt: new Date(2026, 8, 9, 10 + (index % 5)) }; }));
await TicketTimeline.insertMany(tickets.flatMap(ticket => { const status = ticket.status; const steps = ['Open', ...(status !== 'Open' ? ['Request Reviewed', 'Engineer Assigned'] : []), ...( ['Engineer Accepted', 'In Progress', 'Waiting for Parts', 'Completed', 'Closed'].includes(status) ? ['Engineer Accepted'] : []), ...( ['In Progress', 'Waiting for Parts', 'Completed', 'Closed'].includes(status) ? ['In Progress'] : []), ...( ['Waiting for Parts', 'Completed', 'Closed'].includes(status) ? ['Waiting for Parts'] : []), ...( ['Completed', 'Closed'].includes(status) ? ['Completed'] : []), ...(status === 'Closed' ? ['Closed'] : [])]; return steps.map(step => ({ ticketId: ticket._id, status: step, message: step === 'Open' ? 'Service request created by Corporate Admin.' : `${step} update recorded for demonstration.`, updatedBy: step === 'Open' ? 'Corporate Portal' : serviceUser.name, userRole: step === 'Open' ? 'corporate_admin' : 'iplanet_service' })); }));
console.log('Seeded corporate admins, iPlanet service users, engineers, device master, devices, and shared tickets.');
console.log('Corporate Admin: admin@corporate.local / Demo@123');
console.log('iPlanet Service: service@iplanet.local / Demo@123');
await mongoose.disconnect();
