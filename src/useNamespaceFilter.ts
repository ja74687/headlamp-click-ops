import { useCallback, useMemo } from 'react';
import { useDispatch, useSelector } from 'react-redux';

/**
 * Headlamp's topbar namespace filter, read and written straight from its Redux store.
 *
 * Not part of the plugin API: `state.filter.namespaces` and the `filter/setNamespaceFilter`
 * action are Headlamp internals and may change between versions. The selector tolerates
 * both the Set and the array shape it has had so far.
 */
const SET_NAMESPACE_FILTER = 'filter/setNamespaceFilter';

export function useGlobalNamespaces(): string[] {
  const namespacesSet = useSelector(
    (state: { filter?: { namespaces?: Set<string> | string[] } }) => state?.filter?.namespaces
  );
  return useMemo(() => {
    if (!namespacesSet) return [];
    if (namespacesSet instanceof Set) return [...namespacesSet];
    if (Array.isArray(namespacesSet)) return [...namespacesSet];
    return [];
  }, [namespacesSet]);
}

export function useSetGlobalNamespaces(): (next: string[]) => void {
  const dispatch = useDispatch();
  return useCallback(
    (next: string[]) => dispatch({ type: SET_NAMESPACE_FILTER, payload: next }),
    [dispatch]
  );
}
