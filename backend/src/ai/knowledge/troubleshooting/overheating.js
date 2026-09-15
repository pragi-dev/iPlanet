export const overheatingKnowledge = {
  id: 'device-overheating', category: 'overheating', title: 'Device overheating',
  deviceTypes: ['iPhone', 'iPad', 'Mac'],
  keywords: ['hot', 'heat', 'overheat', 'overheating', 'warm', 'temperature warning'],
  symptoms: ['Device feels unusually hot', 'Temperature warning appears', 'Performance slows while the device is warm'],
  possibleCauses: ['Charging while running demanding apps', 'Direct sunlight or poor ventilation', 'High processor or network activity'],
  troubleshootingSteps: ['Disconnect charging accessories if safe to do so.', 'Move the device to a cool, ventilated location.', 'Close demanding apps and allow the device to cool naturally.', 'Restart only after the device has cooled and is responsive.'],
  questions: ['Is the device charging or showing a temperature warning?', 'Did this start during a specific app or activity?'],
  escalationConditions: ['The device remains hot after cooling', 'There is swelling, damage, smoke, or unusual smell', 'A temperature warning persists']
};
