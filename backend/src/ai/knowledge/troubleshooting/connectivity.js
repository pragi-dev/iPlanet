export const connectivityKnowledge = {
  id: 'wifi-connectivity', category: 'connectivity', title: 'Wi-Fi and connectivity problems',
  deviceTypes: ['iPhone', 'iPad', 'Mac'],
  keywords: ['wifi', 'wi-fi', 'internet', 'network', 'bluetooth', 'connectivity', 'disconnecting', 'won\'t connect'],
  symptoms: ['Wi-Fi disconnects repeatedly', 'Device cannot join an approved network', 'Internet is unavailable on one device'],
  possibleCauses: ['Temporary network issue', 'Wi-Fi or Bluetooth state issue', 'Weak signal'],
  troubleshootingSteps: ['Check whether another approved device can connect to the same network.', 'Toggle Wi-Fi or Bluetooth off and on, then reconnect.', 'Move closer to the approved access point if signal is weak.', 'Restart the device if the issue continues.'],
  questions: ['Can other approved devices connect to this network?', 'Is this affecting Wi-Fi, Bluetooth, or both?'],
  escalationConditions: ['The problem affects multiple users or devices', 'The device cannot connect after safe checks', 'The network requires corporate access changes']
};
