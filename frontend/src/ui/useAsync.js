import { useCallback, useEffect, useRef, useState } from 'react';

// Loads data with explicit loading / error / retry states. It never
// substitutes placeholder data when a request fails.
export function useAsync(loader, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const requestId = useRef(0);

  const run = useCallback(({ silent = false } = {}) => {
    const id = ++requestId.current;
    if (!silent) setState(current => ({ ...current, loading: true, error: null }));
    return Promise.resolve()
      .then(() => loaderRef.current())
      .then(data => { if (id === requestId.current) setState({ data, error: null, loading: false }); return data; })
      .catch(error => { if (id === requestId.current) setState(current => ({ data: silent ? current.data : null, error, loading: false })); });
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void run(); }, deps);

  return { ...state, reload: run, setData: updater => setState(current => ({ ...current, data: typeof updater === 'function' ? updater(current.data) : updater })) };
}
