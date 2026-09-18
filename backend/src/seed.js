import 'dotenv/config';
import mongoose from 'mongoose';
import { User, Company, ServiceCentre, Device, DeviceMaster, Engineer, Ticket, TicketTimeline, Notification, EscalationRule, CallRecord, AITroubleshootingSession } from './models.js';
import { demoEnrollmentDevices } from './demoData.js';

const password = 'Demo@123';
if (process.argv[2] !== '--reset-demo') throw new Error('Refusing to clear MongoDB. Run `npm run seed:demo` to reset the demo dataset explicitly.');
const locations = ['Chennai', 'Coimbatore', 'Bengaluru', 'Madurai'];
const companyDefinitions = [
  { name: 'ABC Technologies', companyId: 'CO-001', contactName: 'Arjun Kumar', contactEmail: 'arjun.kumar@abctechnologies.in', phone: '+91 44 4012 8800', location: 'Chennai' },
  { name: 'XYZ Solutions', companyId: 'CO-002', contactName: 'Rahul Menon', contactEmail: 'rahul.menon@xyzsolutions.in', phone: '+91 80 4123 7700', location: 'Bengaluru' },
  { name: 'Demo Corporation', companyId: 'CO-003', contactName: 'Karthik Raj', contactEmail: 'karthik.raj@democorporation.in', phone: '+91 422 456 9900', location: 'Coimbatore' }
];
const serviceCentreDefinitions = [
  { serviceCentreId: 'SC-CHN-001', name: 'Chennai Service Centre', location: 'Chennai', city: 'Chennai', state: 'Tamil Nadu', contactNumber: '+91 44 4012 8801', email: 'chennai.service@iplanetcare.in' },
  { serviceCentreId: 'SC-CBE-001', name: 'Coimbatore Service Centre', location: 'Coimbatore', city: 'Coimbatore', state: 'Tamil Nadu', contactNumber: '+91 422 456 9901', email: 'coimbatore.service@iplanetcare.in' },
  { serviceCentreId: 'SC-BLR-001', name: 'Bengaluru Service Centre', location: 'Bengaluru', city: 'Bengaluru', state: 'Karnataka', contactNumber: '+91 80 4123 7701', email: 'bengaluru.service@iplanetcare.in' },
  { serviceCentreId: 'SC-MDU-001', name: 'Madurai Service Centre', location: 'Madurai', city: 'Madurai', state: 'Tamil Nadu', contactNumber: '+91 452 438 2201', email: 'madurai.service@iplanetcare.in' }
];
const corporateUsers = [
  ['Arjun Kumar', 'admin@corporate.local', 0, '+91 98400 11001'],
  ['Meera Krishnan', 'meera.krishnan@abctechnologies.in', 0, '+91 98400 11002'],
  ['Rahul Menon', 'rahul.menon@xyzsolutions.in', 1, '+91 98400 11003'],
  ['Priya Nair', 'priya.nair@xyzsolutions.in', 1, '+91 98400 11004'],
  ['Karthik Raj', 'karthik.raj@democorporation.in', 2, '+91 98400 11005'],
  ['Ananya Iyer', 'ananya.iyer@democorporation.in', 2, '+91 98400 11006']
];
const engineerDefinitions = [
  ['Sanjay Kumar', 'sanjay.kumar@iplanetcare.in', 'SE-2001', 'Chennai', 'Available', '+91 98410 22001'],
  ['Vishal Raj', 'vishal.raj@iplanetcare.in', 'SE-2002', 'Coimbatore', 'Busy', '+91 98410 22002'],
  ['Mohammed Irfan', 'mohammed.irfan@iplanetcare.in', 'SE-2003', 'Bengaluru', 'Available', '+91 98410 22003'],
  ['Naveen Prakash', 'naveen.prakash@iplanetcare.in', 'SE-2004', 'Madurai', 'Busy', '+91 98410 22004'],
  ['Suresh Babu', 'suresh.babu@iplanetcare.in', 'SE-2005', 'Chennai', 'Available', '+91 98410 22005'],
  ['Akash Menon', 'akash.menon@iplanetcare.in', 'SE-2006', 'Bengaluru', 'Offline', '+91 98410 22006']
];
const employeeProfiles = [
  ['EMP1001', 'Divya Srinivasan', 'IT', 'IT Manager', 'Chennai', 0], ['EMP1002', 'Naveen Kumar', 'Operations', 'Operations Lead', 'Coimbatore', 0],
  ['EMP1003', 'Harish Menon', 'Finance', 'Finance Manager', 'Bengaluru', 0], ['EMP1004', 'Ananya Raj', 'Sales', 'Regional Sales Lead', 'Chennai', 0],
  ['EMP2001', 'Rohan Mehta', 'IT', 'Infrastructure Lead', 'Bengaluru', 1], ['EMP2002', 'Lakshmi Nair', 'HR', 'People Operations Manager', 'Madurai', 1],
  ['EMP2003', 'Vikram Shah', 'Finance', 'Financial Controller', 'Bengaluru', 1], ['EMP2004', 'Keerthana Rao', 'Sales', 'Account Director', 'Chennai', 1],
  ['EMP3001', 'Siddharth Rao', 'IT', 'Systems Administrator', 'Coimbatore', 2], ['EMP3002', 'Megha Iyer', 'Operations', 'Operations Manager', 'Chennai', 2],
  ['EMP3003', 'Aditya Menon', 'Finance', 'Senior Analyst', 'Coimbatore', 2], ['EMP3004', 'Ishita Bose', 'Sales', 'Client Success Lead', 'Chennai', 2]
];
const deviceDefinitions = [
  ['AST-ABC-001', 'C02ZK1A1ABCD', 'MacBook Air M2', 'MacBook', 0, 'Divya Srinivasan', 'EMP1001', 'IT', 'Chennai', 'Active', 'Active', 'Assigned', 'In Use'],
  ['AST-ABC-002', 'C02ZK1A1ABCE', 'iPhone 15 Pro', 'iPhone', 0, 'Naveen Kumar', 'EMP1002', 'Operations', 'Coimbatore', 'Active', 'Active', 'Assigned', 'In Use'],
  ['AST-ABC-003', 'C02ZK1A1ABCF', 'MacBook Pro 14-inch', 'MacBook', 0, 'Harish Menon', 'EMP1003', 'Finance', 'Bengaluru', 'Expiring Soon', 'Active', 'Assigned', 'In Use'],
  ['AST-ABC-004', 'C02ZK1A1ABCG', 'iPad Air', 'iPad', 0, 'Ananya Raj', 'EMP1004', 'Sales', 'Chennai', 'Active', 'Expiring Soon', 'Assigned', 'In Use'],
  ['AST-ABC-005', 'C02ZK1A1ABCH', 'iPhone 16', 'iPhone', 0, null, null, null, 'Chennai', 'Active', 'Active', 'Unassigned', 'In Use'],
  ['AST-ABC-006', 'C02ZK1A1ABCI', 'MacBook Pro 16-inch', 'MacBook', 0, null, null, null, 'Coimbatore', 'Expired', 'Expired', 'Unassigned', 'Retired'],
  ['AST-XYZ-001', 'C02ZK2B1ABCD', 'iPhone 16 Pro', 'iPhone', 1, 'Rohan Mehta', 'EMP2001', 'IT', 'Bengaluru', 'Active', 'Active', 'Assigned', 'In Use'],
  ['AST-XYZ-002', 'C02ZK2B1ABCE', 'MacBook Air M3', 'MacBook', 1, 'Lakshmi Nair', 'EMP2002', 'HR', 'Madurai', 'Active', 'Expiring Soon', 'Assigned', 'In Use'],
  ['AST-XYZ-003', 'C02ZK2B1ABCF', 'iPad Pro 12.9', 'iPad', 1, 'Vikram Shah', 'EMP2003', 'Finance', 'Bengaluru', 'Expiring Soon', 'Active', 'Assigned', 'In Use'],
  ['AST-XYZ-004', 'C02ZK2B1ABCG', 'iPhone 15', 'iPhone', 1, 'Keerthana Rao', 'EMP2004', 'Sales', 'Chennai', 'Active', 'Active', 'Assigned', 'Under Service'],
  ['AST-XYZ-005', 'C02ZK2B1ABCH', 'MacBook Pro 14-inch', 'MacBook', 1, null, null, null, 'Madurai', 'Expired', 'Expired', 'Unassigned', 'Retired'],
  ['AST-DEMO-001', 'C02ZK3C1ABCD', 'MacBook Air M2', 'MacBook', 2, 'Siddharth Rao', 'EMP3001', 'IT', 'Coimbatore', 'Active', 'Active', 'Assigned', 'In Use'],
  ['AST-DEMO-002', 'C02ZK3C1ABCE', 'iPhone 15 Pro', 'iPhone', 2, 'Megha Iyer', 'EMP3002', 'Operations', 'Chennai', 'Active', 'Expiring Soon', 'Assigned', 'In Use'],
  ['AST-DEMO-003', 'C02ZK3C1ABCF', 'iPad Air', 'iPad', 2, 'Aditya Menon', 'EMP3003', 'Finance', 'Coimbatore', 'Expiring Soon', 'Active', 'Assigned', 'In Use'],
  ['AST-DEMO-004', 'C02ZK3C1ABCG', 'iPhone 16', 'iPhone', 2, 'Ishita Bose', 'EMP3004', 'Sales', 'Chennai', 'Active', 'Active', 'Assigned', 'In Use'],
  ['AST-DEMO-005', 'C02ZK3C1ABCH', 'MacBook Pro 16-inch', 'MacBook', 2, null, null, null, 'Coimbatore', 'Expired', 'Expired', 'Unassigned', 'Retired']
];
const ticketDefinitions = [
  [0, 0, 'Service', 'Battery', 'iPhone 15 Pro battery capacity is dropping quickly during normal office use.', 'High', 'Engineer Assigned', 0, 'At Risk'],
  [0, 1, 'Service', 'Performance', 'MacBook Air becomes unresponsive when several finance workbooks are open.', 'Medium', 'In Progress', 1, 'Healthy'],
  [0, 2, 'Service', 'Screen / Display', 'MacBook display flickers after waking from sleep and needs inspection.', 'High', 'Waiting for Parts', 2, 'SLA Breached'],
  [0, 3, 'Health Camp', 'Health Camp', 'Quarterly preventive health check requested for the regional sales iPad.', 'Low', 'Completed', 3, 'Resolved'],
  [0, 4, 'Service', 'Charging', 'Replacement iPhone intermittently stops charging with approved USB-C cables.', 'Critical', 'Open', null, 'At Risk'],
  [0, 5, 'E-Waste', 'Other', 'Retired MacBook is awaiting secure data wipe and responsible recycling.', 'Low', 'Closed', 4, 'Resolved'],
  [1, 6, 'Service', 'Camera', 'iPhone camera shows a black preview in the corporate meeting application.', 'Medium', 'Engineer Accepted', 2, 'Healthy'],
  [1, 7, 'Service', 'Keyboard', 'MacBook keyboard has an intermittent spacebar and return-key response.', 'High', 'In Progress', 1, 'At Risk'],
  [1, 8, 'Service', 'Wi-Fi', 'iPad disconnects from the Bengaluru office Wi-Fi every few minutes.', 'Medium', 'Engineer Assigned', 5, 'Healthy'],
  [1, 9, 'Buyback', 'Other', 'Older iPhone is ready for valuation after replacement fleet deployment.', 'Low', 'Closed', 3, 'Resolved'],
  [1, 10, 'Service', 'Physical Damage', 'Device has a cracked display after an accidental drop and requires inspection.', 'Critical', 'Waiting for Parts', 0, 'SLA Breached'],
  [1, 7, 'Health Camp', 'Health Camp', 'Preventive service review requested for the Madurai HR device pool.', 'Low', 'Completed', 4, 'Resolved'],
  [2, 11, 'Service', 'Overheating', 'MacBook runs unusually hot during video calls and battery drains rapidly.', 'High', 'Engineer Assigned', 1, 'At Risk'],
  [2, 12, 'Service', 'Charging', 'iPhone charging port requires careful inspection after intermittent charging.', 'Medium', 'Open', null, 'Healthy'],
  [2, 13, 'Service', 'Performance', 'iPad applications load slowly after the latest operating system update.', 'Medium', 'Engineer Accepted', 3, 'Healthy'],
  [2, 14, 'E-Waste', 'Other', 'Retired MacBook is scheduled for certified e-waste collection.', 'Low', 'Closed', 5, 'Resolved'],
  [2, 15, 'Service', 'Screen / Display', 'MacBook display has a persistent vertical line on the left side.', 'Critical', 'In Progress', 0, 'SLA Breached'],
  [2, 11, 'Buyback', 'Other', 'Older company MacBook submitted for buyback assessment.', 'Low', 'Completed', 2, 'Resolved'],
  [0, 0, 'Service', 'Battery', 'Battery health alert appears during long customer presentations.', 'Medium', 'Engineer Accepted', 4, 'Healthy'],
  [1, 6, 'Service', 'Software', 'Camera permissions reset after security update and conferencing access is blocked.', 'Medium', 'Open', null, 'Healthy'],
  [2, 13, 'Health Camp', 'Health Camp', 'Annual device wellness check requested for the operations team.', 'Low', 'Closed', 3, 'Resolved']
];
const sequenceByStatus = { Open: ['Open'], 'Engineer Assigned': ['Open', 'Request Reviewed', 'Engineer Assigned'], 'Engineer Accepted': ['Open', 'Request Reviewed', 'Engineer Assigned', 'Engineer Accepted'], 'In Progress': ['Open', 'Request Reviewed', 'Engineer Assigned', 'Engineer Accepted', 'In Progress'], 'Waiting for Parts': ['Open', 'Request Reviewed', 'Engineer Assigned', 'Engineer Accepted', 'In Progress', 'Waiting for Parts'], Completed: ['Open', 'Request Reviewed', 'Engineer Assigned', 'Engineer Accepted', 'In Progress', 'Completed'], Closed: ['Open', 'Request Reviewed', 'Engineer Assigned', 'Engineer Accepted', 'In Progress', 'Completed', 'Closed'] };

const date = (month, day, hour = 10) => new Date(2026, month - 1, day, hour, 0, 0);
await mongoose.connect(process.env.MONGODB_URI);
await Promise.all([User.deleteMany({}), Company.deleteMany({}), ServiceCentre.deleteMany({}), Device.deleteMany({}), DeviceMaster.deleteMany({}), Engineer.deleteMany({}), Ticket.deleteMany({}), TicketTimeline.deleteMany({}), Notification.deleteMany({}), EscalationRule.deleteMany({}), CallRecord.deleteMany({}), AITroubleshootingSession.deleteMany({})]);

const companies = await Company.insertMany(companyDefinitions);
const serviceCentres = await ServiceCentre.insertMany(serviceCentreDefinitions);
const users = [];
for (const [name, email, companyIndex, phone] of corporateUsers) users.push(await User.create({ name, email, password, role: 'corporate_admin', company: companies[companyIndex].name, companyId: companies[companyIndex]._id, phone }));
const serviceUser = await User.create({ name: 'Neha Menon', email: 'service@iplanet.local', password, role: 'iplanet_service', company: 'iPlanet Service Desk', phone: '+91 98410 22000' });
const engineerUsers = await User.insertMany(engineerDefinitions.map(([name, email, employeeId, location, status, phone]) => ({ name, email, password, role: 'iplanet_service', company: 'iPlanet Service Desk', phone })));
const engineers = await Engineer.insertMany(engineerDefinitions.map(([name, email, employeeId, location, status, phone], index) => ({ name, employeeId, email, phone, location, status, userId: engineerUsers[index]._id })));

const devices = await Device.insertMany(deviceDefinitions.map(([assetId, serialNumber, model, deviceType, companyIndex, employeeName, employeeId, department, location, warrantyStatus, amcStatus, allocation, deviceStatus], index) => ({ assetId, serialNumber, deviceType, model, companyId: companies[companyIndex]._id, selectedEntityId: companies[companyIndex]._id, selectedEntityType: 'corporate', employeeName, employeeId, department, location, purchaseDate: date(4 + (index % 8), 5 + (index % 20)), warrantyStatus, warrantyExpiry: warrantyStatus === 'Active' ? date(2027, 4 + (index % 6), 5 + index) : warrantyStatus === 'Expiring Soon' ? date(2026, 10 + (index % 2), 5 + index) : date(2025, 3 + (index % 5), 5 + index), amcStatus, amcExpiry: amcStatus === 'Active' ? date(2028, 2 + (index % 6), 10 + index) : amcStatus === 'Expiring Soon' ? date(2026, 10 + (index % 2), 10 + index) : date(2025, 4 + (index % 5), 10 + index), deviceStatus, deviceAllocationStatus: allocation, lastServiceDate: date(2026, 2 + (index % 6), 12 + (index % 10)) })));
const deviceMasters = [...demoEnrollmentDevices, ...devices.map(device => ({ serialNumber: device.serialNumber, deviceType: device.deviceType, model: device.model, assetId: device.assetId, purchaseDate: device.purchaseDate, warrantyStatus: device.warrantyStatus, warrantyExpiry: device.warrantyExpiry, amcStatus: device.amcStatus, amcExpiry: device.amcExpiry }))];
await DeviceMaster.insertMany(deviceMasters.filter((item, index, all) => all.findIndex(other => other.serialNumber === item.serialNumber) === index));

const tickets = await Ticket.insertMany(ticketDefinitions.map(([companyIndex, deviceIndex, category, issueType, description, priority, status, engineerIndex, slaStatus], index) => {
  const createdAt = date(4 + (index % 6), 2 + (index % 22));
  const device = devices[deviceIndex];
  const assigned = engineerIndex === null ? null : engineers[engineerIndex];
  const targetHours = { Critical: 4, High: 12, Medium: 24, Low: 48 }[priority];
  const resolved = ['Completed', 'Closed'].includes(status);
  return { ticketId: `SR-${1101 + index}`, customerId: users[companyIndex * 2]._id, companyId: companies[companyIndex]._id, serviceCentreId: serviceCentres[locations.indexOf(device.location) % serviceCentres.length]._id, deviceId: device._id, category, issueType, description, images: [], originalImages: [], annotatedImages: [], location: device.location, preferredServiceDate: date(9, 20 + (index % 8)), priority, status, assignedEngineer: assigned?.name || 'Unassigned', assignedEngineerId: assigned?._id, assignedAt: assigned ? new Date(createdAt.getTime() + 86400000) : undefined, expectedTAT: `${targetHours / 12} business days`, responseTarget: `${targetHours} hours`, resolutionTarget: `${targetHours * 2} hours`, slaTargetAt: new Date(createdAt.getTime() + targetHours * 3600000), slaStatus: resolved ? 'Resolved' : slaStatus, escalationLevel: slaStatus === 'SLA Breached' ? 2 : slaStatus === 'At Risk' ? 1 : 0, escalationStatus: resolved ? 'Resolved' : slaStatus === 'SLA Breached' ? 'SLA Breached' : slaStatus === 'At Risk' ? 'At Risk' : 'Not Escalated', escalationReason: slaStatus === 'SLA Breached' ? 'Resolution SLA exceeded' : slaStatus === 'At Risk' ? 'Resolution SLA approaching' : undefined, escalatedAt: slaStatus === 'Healthy' || resolved ? undefined : new Date(createdAt.getTime() + targetHours * 0.8 * 3600000), createdAt, updatedAt: new Date(createdAt.getTime() + (resolved ? 5 : 2) * 86400000) };
}));
const timelineEvents = [];
for (const [index, ticket] of tickets.entries()) {
  for (const [stepIndex, status] of sequenceByStatus[ticket.status].entries()) timelineEvents.push({ ticketId: ticket._id, status, message: status === 'Open' ? 'Service request created by Corporate Admin.' : `${status} recorded by the service desk.`, updatedBy: status === 'Open' ? users[ticket.companyId.equals(companies[0]._id) ? 0 : ticket.companyId.equals(companies[1]._id) ? 2 : 4].name : status === 'Engineer Assigned' ? ticket.assignedEngineer : serviceUser.name, userRole: status === 'Open' ? 'corporate_admin' : 'iplanet_service', timestamp: new Date(ticket.createdAt.getTime() + stepIndex * 86400000) });
}
await TicketTimeline.insertMany(timelineEvents);

const notificationRows = [];
for (const [index, ticket] of tickets.entries()) {
  const corporateUser = users[index % users.length];
  notificationRows.push({ user: corporateUser._id, company: ticket.companyId, portalRole: 'corporate_admin', type: index % 3 === 0 ? 'TICKET_STATUS_UPDATED' : 'NEW_SERVICE_REQUEST', title: index % 3 === 0 ? 'Ticket status updated' : 'Service request created', message: `${ticket.ticketId} for ${ticket.deviceId ? deviceDefinitions[ticket.deviceId ? deviceDefinitions.findIndex(item => item[1] === devices.find(device => device._id.equals(ticket.deviceId)).serialNumber) : 0]?.[2] || 'Apple device' : 'Apple device'} is now ${ticket.status}.`, ticket: ticket._id, device: ticket.deviceId, read: index % 4 === 0 });
  notificationRows.push({ user: serviceUser._id, company: ticket.companyId, portalRole: 'iplanet_service', type: ticket.slaStatus === 'SLA Breached' ? 'SLA_BREACHED' : 'NEW_SERVICE_REQUEST', title: ticket.slaStatus === 'SLA Breached' ? 'SLA breached' : 'New ticket received', message: `${ticket.ticketId} requires service desk attention at ${ticket.location}.`, ticket: ticket._id, device: ticket.deviceId, read: index % 5 === 0 });
}
await Notification.insertMany(notificationRows);
await CallRecord.insertMany(tickets.slice(0, 6).map((ticket, index) => ({ ticketId: ticket._id, agentUserId: serviceUser._id, agentName: serviceUser.name, ticketNumber: ticket.ticketId, customerName: users[index % users.length].name, customerPhone: users[index % users.length].phone, outcome: ['Customer Needs Further Assistance', 'Engineer Visit Required', 'Issue Resolved Remotely'][index % 3], notes: 'Client demonstration call record.', callStatus: index % 2 ? 'Call Completed' : 'Call Attempted' })));
await EscalationRule.insertMany([
  { name: 'Critical priority breach', level: 3, trigger: 'Critical SLA Breach', priority: 'Critical', slaThreshold: 80, action: 'Escalate to Regional Operations Manager' },
  { name: 'High priority breach', level: 2, trigger: 'High Priority SLA Breach', priority: 'High', slaThreshold: 90, action: 'Escalate to Service Manager' },
  { name: 'Standard SLA approaching', level: 1, trigger: 'SLA Approaching', priority: 'All', slaThreshold: 80, action: 'Notify Service Coordinator' },
  { name: 'Standard SLA breach', level: 2, trigger: 'SLA Breached', priority: 'All', slaThreshold: 100, action: 'Escalate to Service Manager' }
]);

const ids = new Set(devices.map(device => String(device._id)));
const ticketIds = new Set(tickets.map(ticket => String(ticket._id)));
if (devices.some(device => !companies.some(company => company._id.equals(device.companyId)))) throw new Error('Device company reference validation failed');
if (tickets.some(ticket => !ids.has(String(ticket.deviceId)) || !ticketIds.has(String(ticket._id)))) throw new Error('Ticket reference validation failed');
if (tickets.some(ticket => ticket.assignedEngineerId && !engineers.some(engineer => engineer._id.equals(ticket.assignedEngineerId)))) throw new Error('Engineer reference validation failed');
console.log('====================================');
console.log('iPlanetCare Demo Data Seed Complete');
console.log('====================================');
console.log(`Companies:        ${companies.length}`);
console.log(`Service Centres:  ${serviceCentres.length}`);
console.log(`Corporate Users:  ${corporateUsers.length}`);
console.log(`Service Users:    ${engineerUsers.length + 1}`);
console.log(`Devices:          ${devices.length}`);
console.log(`Device Masters:   ${deviceMasters.length}`);
console.log(`Engineers:        ${engineers.length}`);
console.log(`Tickets:          ${tickets.length}`);
console.log(`Timelines:        ${timelineEvents.length}`);
console.log(`Notifications:    ${notificationRows.length}`);
console.log(`Calls:            6`);
console.log('Escalation Rules: 4');
console.log('All references validated successfully.');
console.log('Corporate Admin: admin@corporate.local / Demo@123');
console.log('iPlanet Service: service@iplanet.local / Demo@123');
console.log('====================================');
await mongoose.disconnect();
