import { app } from 'electron'
import path from 'node:path'
import { HistoryStore } from './history-store'

let store: HistoryStore | undefined

function getStore(): HistoryStore {
  store ??= new HistoryStore(path.join(app.getPath('userData'), 'history.json'))
  return store
}

export const getHistory = (): ReturnType<HistoryStore['list']> => getStore().list()
export const addHistory = (...args: Parameters<HistoryStore['add']>): Promise<void> =>
  getStore().add(...args)
export const toggleFavorite = (id: string): Promise<void> => getStore().toggleFavorite(id)
export const deleteHistory = (id: string): Promise<void> => getStore().remove(id)
export const renameHistory = (id: string, title: string): Promise<void> =>
  getStore().rename(id, title)
