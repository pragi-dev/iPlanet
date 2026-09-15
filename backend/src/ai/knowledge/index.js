import { batteryKnowledge } from './troubleshooting/battery.js';
import { chargingKnowledge } from './troubleshooting/charging.js';
import { connectivityKnowledge } from './troubleshooting/connectivity.js';
import { overheatingKnowledge } from './troubleshooting/overheating.js';
import { performanceKnowledge } from './troubleshooting/performance.js';

export const knowledgeDocuments = [batteryKnowledge, overheatingKnowledge, chargingKnowledge, connectivityKnowledge, performanceKnowledge];
