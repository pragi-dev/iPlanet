import { demoDevices, demoTickets, locations } from './data';
export const serviceEngineers = [
  { _id: 'engineer-1', name: 'Vikram S', employeeId: 'SE-2001', email: 'engineer@demo.local', phone: '+91 90000 00003', location: 'Chennai', status: 'Available', assignedTicketCount: 2 },
  { _id: 'engineer-2', name: 'Priya Menon', employeeId: 'SE-2002', email: 'engineer2@demo.local', phone: '+91 90000 00004', location: 'Coimbatore', status: 'Busy', assignedTicketCount: 3 },
  { _id: 'engineer-3', name: 'Sanjay Rao', employeeId: 'SE-2003', email: 'engineer3@demo.local', phone: '+91 90000 00005', location: 'Bengaluru', status: 'Available', assignedTicketCount: 1 },
  { _id: 'engineer-4', name: 'Kavya Iyer', employeeId: 'SE-2004', email: 'engineer4@demo.local', phone: '+91 90000 00006', location: 'Madurai', status: 'Busy', assignedTicketCount: 2 },
  { _id: 'engineer-5', name: 'Rohan Das', employeeId: 'SE-2005', email: 'engineer5@demo.local', phone: '+91 90000 00007', location: 'Chennai', status: 'Offline', assignedTicketCount: 0 },
];
export const serviceTickets = demoTickets.map((ticket, index) => ({ ...ticket, customerId: { name: 'Arun Kumar', company: 'Demo Technologies Pvt Ltd', email: 'customer@demo.com', phone: '+91 90000 00000' }, assignedEngineerId: index % 3 === 0 ? null : serviceEngineers[index % serviceEngineers.length], assignedEngineer: index % 3 === 0 ? 'Unassigned' : serviceEngineers[index % serviceEngineers.length].name, preferredServiceDate: '2026-09-12', deviceId: { ...(ticket.deviceId || demoDevices[index % demoDevices.length]) } }));
export const serviceLocationData = locations.map((name, index) => ({ name, value: [6, 5, 4, 3][index] }));
export const serviceVolumeData = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'].map((month, index) => ({ month, tickets: [4, 6, 7, 8, 9, 11, 10, 13, 12][index] }));
