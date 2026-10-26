// The Corporate Self-Care / iPlanet Service choice travels between Sign in and Sign up as ?workspace=service.
export const workspaceFrom = searchParams => (searchParams.get('workspace') === 'service' ? 'service' : 'corporate');
