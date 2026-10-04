// Small composer preferences kept in the drafts table under the app's own
// key: favourite models (11 §11.17).

import { create } from "zustand";
import { openCache } from "@/storage/cache";

const APP = "app";
const FAVORITES = "favoriteModels";

export const useFavorites = create<{ ids: string[]; loaded: boolean }>(() => ({ ids: [], loaded: false }));

export function loadFavorites(): void {
  if (useFavorites.getState().loaded) return;
  useFavorites.setState({ loaded: true });
  void openCache().then(async (cache) => {
    const ids = await cache?.drafts.get<string[]>(APP, FAVORITES).catch(() => undefined);
    if (ids) useFavorites.setState({ ids });
  });
}

export function toggleFavorite(id: string): void {
  const ids = useFavorites.getState().ids;
  const next = ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id];
  useFavorites.setState({ ids: next });
  void openCache().then((cache) => cache?.drafts.put(APP, FAVORITES, next).catch(() => undefined));
}
