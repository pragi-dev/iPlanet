// The steps a customer's support request goes through after they register. The server gives
// the same answer whether or not the details were verified (so the form cannot be used to
// test what is on record), so after submitting, the page knows only that the details were
// received: verification is the current step and everything after it is still ahead.
export const REGISTRATION_STEPS = [
  { key: 'submitted', label: 'Details submitted' },
  { key: 'verified', label: 'Details verified', note: 'We are checking your details against our purchase records.' },
  { key: 'created', label: 'Request created' },
  { key: 'assigned', label: 'Engineer assigned' },
];

// `submittedAt`: when the submission was confirmed. Upcoming steps never get a time.
export function registrationJourney({ submittedAt }) {
  const current = 1;
  return REGISTRATION_STEPS.map((step, index) => ({
    key: step.key,
    label: step.label,
    state: index < current ? 'done' : index === current ? 'current' : 'upcoming',
    at: index < current ? submittedAt : null,
    note: index === current ? step.note : null,
  }));
}
