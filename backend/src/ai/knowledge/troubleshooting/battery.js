export const batteryKnowledge = {
  id: 'battery-drain', category: 'battery', title: 'Battery draining quickly',
  deviceTypes: ['iPhone', 'iPad', 'Mac'],
  keywords: ['battery', 'drain', 'draining', 'dying fast', 'charge dropping', 'battery life'],
  symptoms: ['Battery percentage drops unusually quickly', 'Device needs charging more often than expected'],
  possibleCauses: ['High background app activity', 'Low signal strength', 'Pending software update'],
  troubleshootingSteps: ['Check Battery usage to identify unusually high-use apps.', 'Turn on Low Power Mode where available when immediate runtime is needed.', 'Install available compatible software updates.', 'Restart the device after saving work.'],
  questions: ['Which device and software version are you using?', 'Did the drain begin after installing an app or update?'],
  escalationConditions: ['The device is abnormally hot', 'The battery is swollen or damaged', 'The device shuts down unexpectedly', 'The issue continues after the safe checks']
};
