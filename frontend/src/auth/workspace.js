// The Corporate Self-Care / iPlanet Service choice travels between Sign in and Sign up as ?workspace=service.
export const workspaceFrom = searchParams => (searchParams.get('workspace') === 'service' ? 'service' : 'corporate');
// Sign in also offers B2C Escalations (?workspace=b2c). B2C accounts are created by an administrator, so Sign up does not.
export const signInWorkspaceFrom = searchParams => (searchParams.get('workspace') === 'b2c' ? 'b2c' : workspaceFrom(searchParams));
