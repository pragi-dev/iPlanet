export const performanceKnowledge = {
  id: 'device-performance', category: 'performance', title: 'Slow device and performance problems',
  deviceTypes: ['iPhone', 'iPad', 'Mac'],
  keywords: ['slow', 'performance', 'freezing', 'freeze', 'lag', 'hang', 'crash', 'unresponsive'],
  symptoms: ['Apps respond slowly', 'Device freezes or lags', 'Apps close unexpectedly'],
  possibleCauses: ['Too many active apps', 'Low available storage', 'Pending software update'],
  troubleshootingSteps: ['Save work and close unneeded apps.', 'Restart the device if it is responsive.', 'Check available storage and install compatible software updates.', 'Try to identify whether one app triggers the issue.'],
  questions: ['Is the whole device slow or only one app?', 'How much storage is available?'],
  escalationConditions: ['The device cannot start', 'Repeated crashes continue after updates and restart', 'There are signs of physical damage or data-risk concerns']
};
