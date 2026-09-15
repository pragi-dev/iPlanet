export const chargingKnowledge = {
  id: 'charging-problem', category: 'charging', title: 'Device not charging',
  deviceTypes: ['iPhone', 'iPad', 'Mac'],
  keywords: ['charge', 'charging', 'charger', 'cable', 'adapter', 'not charging', 'won\'t charge'],
  symptoms: ['Battery percentage does not increase', 'Charging indicator does not appear', 'Charging starts and stops'],
  possibleCauses: ['Loose or incompatible accessory', 'Power outlet issue', 'Debris or moisture around a connector'],
  troubleshootingSteps: ['Inspect the cable, adapter, and outlet for visible damage or loose connections.', 'Try a known-good Apple or certified accessory and a different outlet.', 'Allow a very low battery to charge undisturbed for several minutes.', 'Restart the device if it is responsive.'],
  questions: ['Does the charging indicator appear?', 'Have you tried another known-good cable, adapter, and outlet?'],
  escalationConditions: ['Cable or adapter is damaged', 'Connector is wet, burnt, or visibly damaged', 'Battery is swollen', 'The device will not charge after safe accessory checks']
};
